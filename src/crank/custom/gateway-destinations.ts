import { canonical, requireValue } from '../model'
import { keys, object, string } from './definition'

export type GatewayDestination = {label:string;type:'database'|'sftp'|'s3'|'http'|'local';[key:string]:unknown}
/** Owners consent to actual recipients, never an opaque gateway-local alias. */
export function gatewayDestinations(value:unknown,labels:string[]):GatewayDestination[] {
  requireValue(Array.isArray(value) && value.length===labels.length,'Review every concrete private destination')
  const result=value.map(item=>{
    const raw=object(item,'Private destination'),label=string(raw.label,'Destination label',100),type=raw.type
    requireValue(labels.includes(label),'Destination is outside the selected operations')
    if(type==='database'||type==='sftp') {
      keys(raw,['label','type','host','port',type==='database'?'database':'path_prefix'],'Private destination')
      const host=string(raw.host,'Private host',253).toLowerCase()
      requireValue(!/[\s/@?#\\]/.test(host),'Use a host without credentials or URL fields')
      requireValue(typeof raw.port==='number' && Number.isInteger(raw.port) && raw.port>0 && raw.port<=65535,'Private port must be an integer')
      const field=type==='database'?'database':'path_prefix',target=string(raw[field],field,2000)
      if(type==='sftp')requireValue(target.startsWith('/') && !target.split('/').includes('..'),'Use an absolute SFTP path prefix')
      return {label,type,host,port:raw.port,[field]:target} as GatewayDestination
    }
    if(type==='s3') {
      keys(raw,['label','type','endpoint','bucket','prefix'],'Private destination')
      const endpoint=string(raw.endpoint,'Storage endpoint',2000),url=new URL(endpoint)
      requireValue((url.protocol==='https:' || url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)) && !url.username && !url.password && !url.search && !url.hash && url.pathname==='/','Use a credential-free HTTPS storage origin')
      requireValue(typeof raw.prefix==='string' && raw.prefix.length<=2000,'Review a storage prefix')
      return {label,type,endpoint:url.origin,bucket:string(raw.bucket,'Bucket'),prefix:raw.prefix} as GatewayDestination
    }
    if(type==='http') {
      keys(raw,['label','type','base_url'],'Private destination')
      const url=new URL(string(raw.base_url,'HTTP base URL',2000))
      requireValue(url.protocol==='https:' && !url.username && !url.password && !url.search && !url.hash,'Use a credential-free HTTPS base URL')
      return {label,type,base_url:url.href} as GatewayDestination
    }
    requireValue(type==='local','Unsupported private destination type')
    keys(raw,['label','type','path'],'Private destination')
    return {label,type,path:string(raw.path,'Customer-host path',2000)} as GatewayDestination
  })
  requireValue(new Set(result.map(d=>d.label)).size===labels.length,'Each destination label needs exactly one descriptor')
  return JSON.parse(canonical(result))
}
