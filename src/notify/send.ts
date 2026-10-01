// Detached sender used by notifyDetached(): node --import tsx send.ts <base64 JSON NotifyInput>
import { notify, type NotifyInput } from './notify.js';

const input = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8')) as NotifyInput;
await notify(input).catch(() => {});
