import json
base={'id':'table:synthetic-crank-201','recipients':[],'fields':['record keys','safe integers or integer lists','operation receipts']}
def guard(disclosed):return '201' not in json.dumps({k:v for k,v in disclosed.items() if k!='id'})
assert '201' in json.dumps(base)
assert guard(base)
for leak in ({'value':201},{'record':{'value':201}},{'values':[101,201]},{'payload':'201'}):
 assert not guard({**base,**leak})
print('Opaque identity collision reproduced; filtered disclosure passes; numeric, nested, list and string value leaks refused.')
