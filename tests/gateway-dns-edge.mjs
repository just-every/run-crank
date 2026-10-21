// Preloaded only by the explicit public CLI DNS-edge cases. The real gateway
// resolves a granted hostname; this network edge supplies a hostile DNS answer.
import dns from 'node:dns/promises';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
const lookup=dns.lookup,connect=net.Socket.prototype.connect;
const host=process.env.CRANK_TEST_DNS_HOST,address=process.env.CRANK_TEST_DNS_ADDRESS;
dns.lookup=async(name,options)=>name===host?[{address,family:net.isIP(address)}]:lookup(name,options);
net.Socket.prototype.connect=function(...args){
  const target=typeof args[0]==='object'?args[0]?.host:args[1];
  if(target===address)throw Error('The test network edge refuses a metadata socket');
  return connect.apply(this,args);
};
syncBuiltinESMExports();
