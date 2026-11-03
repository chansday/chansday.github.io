import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {basename} from 'node:path';
import {decryptInvestorData} from '../providers/private-envelope.js';
const input=process.argv[2],keyFile=process.argv[3];
if(!input||!input.endsWith('.json.enc')||!keyFile){console.error('Usage: node scripts/decrypt-investor-flow.mjs <file.json.enc> <private-key.pem>');process.exitCode=1;}
else try{const data=decryptInvestorData(await readFile(input,'utf8'),await readFile(keyFile,'utf8'));await mkdir('.private-data/investor',{recursive:true,mode:0o700});const path=`.private-data/investor/${basename(input).replace(/\.enc$/,'')}`;await writeFile(path,JSON.stringify(data,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});console.log(`Saved local decrypted data: ${path}`);}catch(error){console.error(`Decryption failed: ${error.message}`);process.exitCode=1;}
