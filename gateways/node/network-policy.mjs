import { lookup } from 'node:dns/promises';
import { BlockList, isIP, Socket, connect } from 'node:net';
import { fail } from './errors.mjs';

const blocked = new BlockList();
for (const [network, bits] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(network, bits, 'ipv4');
for (const address of ['100.100.100.200', '168.63.129.16']) blocked.addAddress(address, 'ipv4');
for (const [network, bits] of [['::', 128], ['fe80::', 10], ['ff00::', 8], ['fd00:ec2::254', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['2001::', 32]]) blocked.addSubnet(network, bits, 'ipv6');
const refused = () => fail('operation_refused', 'Private destination resolves to a refused address or metadata service.');

export function normalizedHost(host) {
  if (typeof host !== 'string' || !host || host.length > 253 || /[\s\x00-\x1f\x7f\/@?#%]/.test(host)) refused();
  const value = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!value || value === 'metadata' || value.startsWith('metadata.') ||
      ['metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal'].includes(value)) refused();
  return value;
}
export function allowedAddress(address) {
  const family = isIP(address);
  if (!family || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')) refused();
  // BlockList also applies IPv4 ranges to IPv4-mapped IPv6 addresses.
  return { address, family };
}
export async function resolveDestination(host, { loopbackOnly = false } = {}) {
  const name = normalizedHost(host);
  let records, timer;
  try {
    records = isIP(name) ? [allowedAddress(name)] : await Promise.race([
      lookup(name, { all: true, verbatim: true }),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error()), 2500); }),
    ]);
  }
  catch { refused(); }
  finally { clearTimeout(timer); }
  if (!records.length || records.length > 64) refused();
  for (const record of records) {
    allowedAddress(record.address);
    if (loopbackOnly && !(record.family === 4 ? record.address.startsWith('127.') : record.address === '::1')) refused();
  }
  return records[0];
}
export function pinnedLookup(record) {
  return (_host, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    queueMicrotask(() => callback(null, options?.all ? [record] : record.address, record.family));
  };
}
export function pinnedSocket(record) {
  const socket = new Socket();
  socket.connect = function (port) {
    return Socket.prototype.connect.call(this, { host: record.address, port, family: record.family });
  };
  return socket;
}
export function connectPinned(record, port, signal) {
  return connect({ host: record.address, port, family: record.family, signal });
}
export function connectedSocket(record, port, signal) {
  return new Promise((resolve, reject) => {
    const socket = connectPinned(record, port, signal);
    const failed = error => { socket.destroy(); reject(error); };
    socket.once('error', failed);
    socket.once('connect', () => { socket.removeListener('error', failed); resolve(socket); });
  });
}
