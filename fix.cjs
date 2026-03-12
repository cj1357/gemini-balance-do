const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'src/handler.ts');
let content = fs.readFileSync(file, 'utf-8');

const fetchStart = content.indexOf('\tasync fetch(request');
const forwardStart = content.indexOf('\tasync forwardRequest(', fetchStart);
if (fetchStart !== -1 && forwardStart !== -1) {
    content = content.substring(0, fetchStart) + content.substring(forwardStart);
}

const oldForwardStart = content.indexOf('\tasync forwardRequest(');
const newForwardStart = content.indexOf('\tasync function forwardRequest(');
if (oldForwardStart !== -1 && newForwardStart !== -1) {
    content = content.substring(0, oldForwardStart) + content.substring(newForwardStart);
}

content = content.replace(/\bprivate parseStream\b/g, 'function parseStream');
content = content.replace(/\bprivate parseStreamFlush\b/g, 'function parseStreamFlush');
content = content.replace(/\bprivate toOpenAiStream\b/g, 'function toOpenAiStream');
content = content.replace(/\bprivate toOpenAiStreamFlush\b/g, 'function toOpenAiStreamFlush');

const adminIdx = content.indexOf('\t// =================================================================================================\r\n\t// Admin API Handlers');
if (adminIdx === -1) {
    const adminIdxLF = content.indexOf('\t// =================================================================================================\n\t// Admin API Handlers');
    if (adminIdxLF !== -1) content = content.substring(0, adminIdxLF);
} else {
    content = content.substring(0, adminIdx);
}

fs.writeFileSync(file, content);
console.log('Fixed handler.ts');
