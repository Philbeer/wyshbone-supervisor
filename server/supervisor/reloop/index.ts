import { registerExecutor } from './executor-registry';
import { gpCascadeAdapter } from './gp-cascade-adapter';
import { gpt4oAdapter } from './gpt4o-adapter';

registerExecutor('gp_cascade', gpCascadeAdapter);
registerExecutor('gpt4o_search', gpt4oAdapter);

export { runReloop } from './loop-skeleton';
export * from './types';
export { registerExecutor, getAvailableExecutors } from './executor-registry';
