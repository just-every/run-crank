const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const json = value => encode(new TextEncoder().encode(JSON.stringify(value)));
export async function keyPair() {
 const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 return {...await crypto.subtle.exportKey('jwk',pair.privateKey),kid:crypto.randomUUID(),alg:'ES256',use:'sig'};
}
export function publicKey(key) { return {kty:key.kty,crv:key.crv,x:key.x,y:key.y,kid:key.kid,alg:'ES256',use:'sig',key_ops:['verify']}; }
export async function assertion(key, claims) {
 const encoded = `${json({alg:'ES256',typ:'JWT',kid:key.kid})}.${json(claims)}`;
 const imported = await crypto.subtle.importKey('jwk',{...key,key_ops:['sign']},{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 return `${encoded}.${encode(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},imported,new TextEncoder().encode(encoded))))}`;
}
export async function digest(value) { return encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))); }
