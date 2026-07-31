/**
 * Cloudflare Worker entry — the module wrangler loads (`main` in wrangler.jsonc).
 *
 * It is deliberately two lines. The request pipeline lives in worker/app.ts so it can be
 * exercised by `pnpm test`: this module imports the Durable Object class, and that pulls in
 * `cloudflare:workers`, which the node test runner cannot resolve. The DO class is re-exported
 * here because wrangler binds Durable Objects to the classes exported from the Worker's main
 * module.
 */
export { TaskDO } from './task-do.ts'
export { default } from './app.ts'
