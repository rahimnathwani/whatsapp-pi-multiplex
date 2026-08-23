#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { loadRouterConfig } from './router-config.js';
import { RouterServer } from './router-server.js';

const configPath = process.env.WHATSAPP_PI_ROUTER_CONFIG || '/etc/whatsapp-pi-router/config.json';
const config = await loadRouterConfig(configPath);
const router = new RouterServer(config);
await router.start();
console.log(`[router] listening on ${config.socketPath}; type "status" or send SIGUSR1 for status`);

const printStatus = () => console.log(JSON.stringify(router.status()));
process.on('SIGUSR1', printStatus);
if (process.stdin.isTTY) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    terminal.on('line', line => { if (line.trim() === 'status') printStatus(); });
}
let stopping = false;
const stop = async () => {
    if (stopping) return;
    stopping = true;
    await router.stop();
    process.exitCode = 0;
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
