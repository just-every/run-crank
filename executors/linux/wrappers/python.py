import json
import runpy
import sys

# -I -S excludes user configuration and installed third-party packages.
with open('/task/input.json', encoding='utf-8') as source:
    task_input = json.load(source)
namespace = runpy.run_path('/task/code.py')
result = namespace['main'](task_input)
sys.stdout.write(json.dumps(result, allow_nan=False, separators=(',', ':')))
