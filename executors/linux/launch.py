"""Trusted supervisor: bounded bwrap child, pidfd cancellation, no host environment."""
import json
import math
import os
import resource
import selectors
import signal
import subprocess
import sys
import time

MAX_OUTPUT = 1024 * 1024


def run(config):
    def limits():
        for kind, value in [
            (resource.RLIMIT_AS, config['memory_mb'] * 1024 * 1024),
            (resource.RLIMIT_NPROC, 64), (resource.RLIMIT_NOFILE, 64),
            (resource.RLIMIT_FSIZE, MAX_OUTPUT), (resource.RLIMIT_CORE, 0),
            (resource.RLIMIT_CPU, math.ceil(config['timeout_ms'] / 1000) + 1),
        ]:
            resource.setrlimit(kind, (value, value))

    started = time.monotonic()
    child = subprocess.Popen(config['command'], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env={}, preexec_fn=limits, start_new_session=True)
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
    if failure:
        return {'error': failure}
    if child.returncode != 0:
        return {'error': 'execution_failed'}
    try:
        value = json.loads(output, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeDecodeError):
        return {'error': 'invalid_output'}
    return {'output': value}


try:
    with open(sys.argv[1], encoding='utf-8') as config_file:
        config = json.load(config_file)
    result = run(config)
except Exception:
    result = {'error': 'sandbox_unavailable'}
sys.stdout.write(json.dumps(result, allow_nan=False, separators=(',', ':')))
