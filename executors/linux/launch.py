"""Trusted supervisor: bounded bwrap child, pidfd cancellation, no host environment."""
import json
import fcntl
from pathlib import Path
import math
import os
import resource
import selectors
import signal
import subprocess
import sys
import time

MAX_OUTPUT = 1024 * 1024


class QuotaSetup(Exception):
    pass


def durable_result(config, result):
    target = Path(config['task_dir']) / 'quota-result.json'
    temporary = target.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(result, stream, allow_nan=False, separators=(',', ':'))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
    directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


class Quota:
    def __init__(self, config, recovery=False):
        self.config = config
        self.path = None
        if 'aggregate_memory_mb' not in config:
            return
        try:
            root = Path(config['cgroup_root'])
            # The operator supplies a delegated cgroup v2 subtree, never a task path.
            mounts = [line.split(' - ', 1) for line in Path('/proc/self/mountinfo').read_text().splitlines()]
            unified = [Path(left.split()[4]) for left, right in mounts if right.split()[0] == 'cgroup2']
            if (not root.is_absolute() or root.is_symlink()
                    or not any(root.resolve().is_relative_to(mount) for mount in unified)):
                raise QuotaSetup()
            if not recovery:
                controllers = (root / 'cgroup.subtree_control').read_text().split()
                if not {'memory', 'pids'}.issubset(controllers):
                    raise QuotaSetup()
            self.path = root / ('task-' + config['task_id'])
        except (OSError, KeyError, TypeError):
            raise QuotaSetup() from None

    def create(self):
        if self.path is None:
            return
        try:
            self.path.mkdir(mode=0o700)
            for name, value in [('memory.max', self.config['aggregate_memory_mb'] * 1024 * 1024),
                                ('memory.swap.max', 0), ('memory.oom.group', 1), ('pids.max', 64)]:
                (self.path / name).write_text(str(value))
            if not os.access(self.path / 'cgroup.kill', os.W_OK):
                raise QuotaSetup()
            # Verify kernel readback before allowing even bubblewrap to execute.
            for name, value in [('memory.max', self.config['aggregate_memory_mb'] * 1024 * 1024),
                                ('memory.swap.max', 0), ('memory.oom.group', 1), ('pids.max', 64)]:
                if (self.path / name).read_text().strip() != str(value):
                    raise QuotaSetup()
        except OSError:
            raise QuotaSetup() from None

    def enter(self):
        if self.path is not None:
            (self.path / 'cgroup.procs').write_text(str(os.getpid()))

    def killed(self):
        if self.path is None or not self.path.exists():
            return False
        events = dict(line.split() for line in (self.path / 'memory.events').read_text().splitlines())
        return int(events.get('oom_kill', '0')) > 0

    def stop(self):
        if self.path is None or not self.path.exists():
            return
        (self.path / 'cgroup.kill').write_text('1')
        end = time.monotonic() + 5
        while 'populated 1' in (self.path / 'cgroup.events').read_text():
            if time.monotonic() >= end:
                raise QuotaSetup()
            time.sleep(0.01)

    def remove(self):
        if self.path is not None and self.path.exists():
            self.path.rmdir()


def run(config, quota):
    def limits():
        quota.enter()
        for kind, value in [
            (resource.RLIMIT_AS, config['memory_mb'] * 1024 * 1024),
            (resource.RLIMIT_NPROC, 64), (resource.RLIMIT_NOFILE, 64),
            (resource.RLIMIT_FSIZE, MAX_OUTPUT), (resource.RLIMIT_CORE, 0),
            (resource.RLIMIT_CPU, math.ceil(config['timeout_ms'] / 1000) + 1),
        ]:
            resource.setrlimit(kind, (value, value))

    quota.create()
    started = time.monotonic()
    try:
        child = subprocess.Popen(config['command'], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 env={}, preexec_fn=limits, start_new_session=True)
    except subprocess.SubprocessError:
        if quota.path is not None:
            raise QuotaSetup() from None
        raise
    pidfd = os.pidfd_open(child.pid)
    poller = selectors.DefaultSelector()
    poller.register(sys.stdin.fileno(), selectors.EVENT_READ, 'control')
    poller.register(child.stdout, selectors.EVENT_READ, 'stdout')
    poller.register(pidfd, selectors.EVENT_READ, 'exit')
    output = bytearray()
    failure = None
    exited = False
    eof = False
    try:
        while not (exited and eof):
            remaining = config['timeout_ms'] / 1000 - (time.monotonic() - started)
            if remaining <= 0:
                failure = 'timeout'
                break
            for key, _ in poller.select(remaining):
                if key.data == 'control':
                    os.read(sys.stdin.fileno(), 4096)
                    failure = 'cancelled'
                    break
                if key.data == 'exit':
                    exited = True
                    poller.unregister(pidfd)
                if key.data == 'stdout':
                    chunk = os.read(child.stdout.fileno(), 65536)
                    if not chunk:
                        eof = True
                        poller.unregister(child.stdout)
                    else:
                        output.extend(chunk)
                        if len(output) > MAX_OUTPUT:
                            failure = 'output_limit'
                            break
            if failure:
                break
    finally:
        # A pidfd refers to this exact child, even if its numeric PID is reused.
        # bwrap --die-with-parent and its private PID namespace reap descendants.
        try:
            signal.pidfd_send_signal(pidfd, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        os.close(pidfd)
        poller.close()
        quota.stop()
    if quota.killed():
        return {'error': 'memory_limit'}
    if failure:
        return {'error': failure}
    if child.returncode != 0:
        return {'error': 'execution_failed'}
    try:
        value = json.loads(output, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeDecodeError):
        return {'error': 'invalid_output'}
    return {'output': value}


def supervise(config, recovery=False):
    # A crashed HTTP service closes stdin; this independent supervisor finishes
    # cleanup. Restart waits for that cleanup before reading its durable result.
    lock = Path(config['task_dir']) / 'quota.lock'
    with lock.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        saved = Path(config['task_dir']) / 'quota-result.json'
        if not recovery and saved.exists():
            return json.loads(saved.read_text())
        quota = None
        try:
            quota = Quota(config, recovery)
            if recovery:
                result = json.loads(saved.read_text()) if saved.exists() else {'error': 'interrupted'}
                quota.stop()
                if quota.killed():
                    result = {'error': 'memory_limit'}
            else:
                result = run(config, quota)
        except QuotaSetup:
            if recovery and saved.exists() and json.loads(saved.read_text()).get('error') == 'cgroup_setup_required':
                return json.loads(saved.read_text())
            if recovery:
                raise
            result = {'error': 'cgroup_setup_required'}
        except Exception:
            result = {'error': 'sandbox_unavailable'}
        # Kill descendants even if setup or spawning failed. Record OOM before
        # deleting the only kernel evidence; restart never has to guess or rerun.
        if quota is not None:
            quota.stop()
            if quota.killed():
                result = {'error': 'memory_limit'}
        durable_result(config, result)
        if quota is not None:
            quota.remove()
        return result


try:
    recovery = sys.argv[1] == '--recover'
    with open(sys.argv[2] if recovery else sys.argv[1], encoding='utf-8') as config_file:
        config = json.load(config_file)
    result = supervise(config, recovery)
except Exception:
    result = {'error': 'sandbox_unavailable'}
sys.stdout.write(json.dumps(result, allow_nan=False, separators=(',', ':')))
