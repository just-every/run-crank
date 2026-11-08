#!/usr/bin/env python3
"""Install Playwright's OS dependencies with bounded, isolated apt attempts."""
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time


def group_alive(leader):
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            try:
                fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
                if int(fields[2]) == leader and fields[0] != 'Z':
                    return True
            except FileNotFoundError:
                pass
    return False


def stop_group(leader):
    # The unreaped session leader reserves this ID until cleanup is complete.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(leader, sig)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + 5
        while group_alive(leader):
            if time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        else:
            return
    raise RuntimeError(f'Chromium apt process group {leader} did not stop')


def attempt(env):
    child = subprocess.Popen(
        ['bash', '-ec', 'dpkg --configure -a; pnpm exec playwright install-deps chromium'],
        env=env, start_new_session=True)  # setsid: every launcher/apt child is owned.
    try:
        deadline = time.monotonic() + 120
        # WNOWAIT keeps the leader reserved even when it exits before its children.
        while os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
            if time.monotonic() >= deadline:
                return 124
            time.sleep(0.1)
    finally:
        stop_group(child.pid)
        child.wait()
    return child.returncode


def main():
    with tempfile.TemporaryDirectory(prefix='chromium-apt-') as temporary:
        work = Path(temporary)
        config = work / 'apt.conf'
        # The caller prepares its cache outside HOME before sudo. Never create
        # caller-owned parent directories as root (notably ~/.cache).
        archives = Path(os.environ['APT_ARCHIVES']).resolve(strict=True)
        if not archives.is_dir():
            raise NotADirectoryError(archives)
        print(f'Chromium apt: uid={os.geteuid()} HOME={Path.home()} '
              f'archives={archives} owner={archives.stat().st_uid}', flush=True)
        base = (f'Dir::Cache::archives "{archives}";\n'
                'APT::Keep-Downloaded-Packages "true";\n'
                'APT::Update::Error-Mode "any";\nDPkg::Lock::Timeout "15";\n'
                'Acquire::Retries "1";\n'
                'Acquire::http::Timeout "20";\nAcquire::https::Timeout "20";\n')
        env = dict(os.environ, APT_CONFIG=str(config))
        mirrors = (None, 'http://mirrors.edge.kernel.org/ubuntu/',
                   'http://us-east-1.ec2.archive.ubuntu.com/ubuntu/')
        for number, mirror in enumerate(mirrors, 1):
            config.write_text(base)
            if mirror:
                # Copy the actual sources, including hosted Ubuntu's mirror+file URI.
                sources = work / 'sources'
                sources.mkdir(exist_ok=True)
                for source in (Path('/etc/apt/sources.list'),
                               *Path('/etc/apt/sources.list.d').glob('*')):
                    if source.is_file() and source.suffix in ('.list', '.sources'):
                        text = re.sub(r'mirror\+file:[^\s]+|https?://(?:[a-z0-9.-]*archive\.ubuntu\.com|security\.ubuntu\.com|mirrors\.edge\.kernel\.org)/ubuntu/?',
                                      mirror, source.read_text())
                        (sources / source.name).write_text(text)
                with config.open('a') as stream:
                    stream.write(f'Dir::Etc::sourcelist "-";\nDir::Etc::sourceparts "{sources}";\n')
            print(f"Chromium apt attempt {number}/3: 120s; mirror={mirror or 'configured'}", flush=True)
            status = attempt(env)
            if status == 0:
                return
            print(f'Chromium apt attempt {number}/3 failed: exit {status}', flush=True)
        raise SystemExit(f'Chromium system libraries failed after 3 attempts (last exit {status}); see apt output above')


if __name__ == '__main__':
    main()
