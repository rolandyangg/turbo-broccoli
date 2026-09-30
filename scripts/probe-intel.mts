import { scanRepo, summarizeIntel } from '../src/explore/codeIntel.ts';
console.log(summarizeIntel(scanRepo(process.argv[2] ?? 'fixtures/buggy-site')));
