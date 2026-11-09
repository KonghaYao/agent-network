import { chatClientScript } from '../../src/web/chat-script';

// TypeScript does not parse the browser JavaScript embedded in template strings.
// Compile the actual emitted scripts before launching longer browser suites.
let scripts = 0;
for (const match of chatClientScript(null).matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  new Function(match[1]!);
  scripts++;
}
if (scripts !== 2) throw new Error(`Unexpected inline script count: ${scripts}`);
console.log(`Browser inline syntax: ${scripts} scripts passed`);
