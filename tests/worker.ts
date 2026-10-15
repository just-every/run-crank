// Uses the application's public auth and product handlers with a real D1.
import {authResponse, runtimeBindings} from '../src/auth.server'
import {productApi} from '../src/crank/ui/handler'
export default { async fetch(request:Request,env:any) {
  return await authResponse(request,env) ?? await productApi(request,runtimeBindings(env)) ?? new Response('Not found',{status:404})
} }
