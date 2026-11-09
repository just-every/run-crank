import {chromium} from '/workspace/run-crank/node_modules/@playwright/test/index.mjs';
const launch=chromium.launch.bind(chromium);
chromium.launch=async options=>{
 const browser=await launch(options),newContext=browser.newContext.bind(browser);
 browser.newContext=async options=>{
  const context=await newContext(options),newPage=context.newPage.bind(context);
  context.newPage=async()=>{
   const page=await newPage(),session=await context.newCDPSession(page);
   await session.send('Emulation.setCPUThrottlingRate',{rate:6});
   return page;
  };
  return context;
 };
 return browser;
};
