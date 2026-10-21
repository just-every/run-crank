import { executeTask, GatewayError } from './operations.mjs';

process.once('message', async ({ manifest, manifestPath, task }) => {
  let result;
  try { result = { output: await executeTask(manifest, manifestPath, task) }; }
  catch (error) {
    result = { error: error instanceof GatewayError ? { category: error.category, message: error.message } :
      { category: 'execution_failed', message: 'Configured local operation failed.' } };
  }
  process.send(result, () => process.disconnect());
});
