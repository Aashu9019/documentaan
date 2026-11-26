import { PDFDocument } from '@cantoo/pdf-lib';
import { stripTextInRects } from './src/redact.js';
import fs from 'fs';
const doc = await PDFDocument.load(fs.readFileSync(process.argv[2]));
const page = doc.getPage(0);
console.log('size', page.getSize(), 'contents', page.node.Contents()?.constructor.name);
// "Recipient Name" sits around y=259 (top-down) in a 595-high page -> user y ~ 336
const rect = { x: 200, y: 320, w: 440, h: 40 };
const n = stripTextInRects(doc, page, [rect]);
console.log('removed ops:', n);
fs.writeFileSync(process.argv[3], await doc.save());
