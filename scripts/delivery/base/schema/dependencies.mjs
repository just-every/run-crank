// The caller supplies the complete selected graph, including optional edges.
// Nodes are stable installation identifiers; references never resolve by label.
export function validateDependencyGraph(nodes) {
 if(!Array.isArray(nodes))throw Error('Dependency graph must be a list');
 const graph=new Map();
 for(const node of nodes) {
  if(!node || typeof node.id!=='string' || !node.id || graph.has(node.id) || !Array.isArray(node.dependencies))throw Error('Invalid or duplicate dependency node');
  if(new Set(node.dependencies).size!==node.dependencies.length || node.dependencies.some(id=>typeof id!=='string'))throw Error('Invalid dependency references');
  graph.set(node.id,node.dependencies);
 }
 const visiting=new Set(),visited=new Set();
 function visit(id) {
  if(!graph.has(id))throw Error('Unknown dependency reference');
  if(visiting.has(id))throw Error('Dependency graph contains a cycle');
  if(visited.has(id))return;
  visiting.add(id);for(const next of graph.get(id))visit(next);visiting.delete(id);visited.add(id);
 }
 for(const id of graph.keys())visit(id);
 return nodes;
}
export function dependencyErrors(data) {
 const errors=[],fail=message=>errors.push('$.dependencies: '+message);
 const provides=data.provides??[],dependencies=data.dependencies??[];
 const seen=new Set();
 for(const d of dependencies) {
  if(seen.has(d.interface))fail('interfaces must be unique');seen.add(d.interface);
  if(provides.includes(d.interface))fail('a provider cannot depend on its own interface');
  const field=data.fields.find(f=>f.name===d.address);
  if(!field || field.kind!=='url' || field.runtimeEditable===true)fail('address must reference a declared immutable URL answer');
  if(!d.optional && field?.required!==true)fail('a required dependency address must be a required answer');
  if(d.paths.some(p=>!/^\/[A-Za-z0-9_~/-]+$/.test(p) || p.startsWith('//') || p.split('/').some(v=>v==='.'||v==='..')))fail('registration paths must be safe same-origin paths');
 }
 if(data.dependencyGraph)try{validateDependencyGraph(data.dependencyGraph);}catch(e){fail(e.message);}
 return errors;
}
