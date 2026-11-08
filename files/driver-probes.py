import json, os, shutil, subprocess, tempfile
from pathlib import Path
source=Path('/workspace/run-crank/scripts/container-qualify.mjs')
receipt=[]
def check_case(name, *, installed='0.2.91', occupied=False):
    with tempfile.TemporaryDirectory(prefix='qualification-driver-') as temporary:
        root=Path(temporary)
        (root/'bin').mkdir()
        (root/'node_modules/.bin').mkdir(parents=True)
        (root/'node_modules/@runeditrun/rer').mkdir(parents=True)
        (root/'package.json').write_text(json.dumps({'devDependencies':{'@runeditrun/rer':'0.2.91'},'packageManager':'pnpm@10.12.4'}))
        (root/'node_modules/@runeditrun/rer/package.json').write_text(json.dumps({'version':installed}))
        for command in ['npm','pnpm']:
            target=root/'bin'/command
            target.write_text('#!/bin/sh\nexit 0\n');target.chmod(0o755)
        target=root/'bin/docker'
        target.write_text('#!/bin/sh\nif [ "$1" = volume ] && [ "$2" = ls ]; then\n' + ('printf "rer-local-%s-data\\n"\n' % __import__('hashlib').sha256(str(root).encode()).hexdigest()[:16] if occupied else ':\n') + 'fi\nexit 0\n')
        target.chmod(0o755)
        target=root/'node_modules/.bin/rer'
        target.write_text('#!/bin/sh\nprintf "SYNTHETIC failing build output\\nsecond diagnostic line\\n"\nexit 17\n');target.chmod(0o755)
        output=root/'public'
        env={**os.environ,'PATH':str(root/'bin')+':'+os.environ['PATH'],'QUALIFICATION_OUTPUT':str(output),'GITHUB_SHA':'1'*40}
        run=subprocess.run(['node',str(source)],cwd=root,env=env,capture_output=True,text=True,timeout=20)
        report=json.loads((output/'result.json').read_text())
        assert run.returncode==1
        assert report['passed'] is False
        assert len(report['rows'])==6
        assert all(r['status']=='NOT RUN' for r in report['rows'][2:])
        if name=='build failure':
            assert report['rows'][0]['status']=='PASS'
            assert report['rows'][1]['status']=='FAIL'
            assert 'SYNTHETIC failing build output\nsecond diagnostic line' in (output/'logs/build.log').read_text()
            assert '17' in report['rows'][1]['reason']
        else:
            assert report['rows'][0]['status']=='FAIL'
            assert report['rows'][1]['status']=='NOT RUN'
            assert 'volume rm' not in run.stdout
        assert 'NOT RUN is not a pass' in (output/'summary.md').read_text()
        receipt.append({'probe':name,'result':'pass','driver_exit':run.returncode,'qualification':False})
        # Simulate a killed process's persisted state. Finalization must fail it.
        report['rows'][1].update(status='RUNNING',startedAt='2026-11-08T00:00:00Z')
        (output/'result.json').write_text(json.dumps(report))
        summary=subprocess.run(['node',str(source),'--summary'],cwd=root,env=env,capture_output=True,text=True,timeout=20)
        final=json.loads((output/'result.json').read_text())
        assert summary.returncode==1
        assert final['rows'][1]['status']=='FAIL'
        assert 'Interrupted' in final['rows'][1]['reason']
check_case('build failure')
check_case('pin mismatch',installed='0.2.92')
check_case('existing volume custody',occupied=True)
packet=Path.home()/'rer-consolidation/work/sx-crank-container-hosted-1/packet'
(packet/'driver-probes.json').write_text(json.dumps({'scope':'Synthetic command-boundary reporting tests only; no container acceptance is established.','probes':receipt,'interrupted_finalization':'pass'},indent=2)+'\n')
print(json.dumps(receipt))
