import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {encryptInvestorData} from '../providers/private-envelope.js';
import {importInvestorKey,decryptInvestorEnvelope,investorIndex,formatInvestorShares} from '../providers/investor-view.js';
test('browser decrypts encrypted collection using the private key',async()=>{
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const data={stocks:[{symbol:'011420',rows:[{date:'2026-10-26',foreign_net_shares:-120}]}]};
  const key=await importInvestorKey(privateKey);
  assert.deepEqual(await decryptInvestorEnvelope(JSON.parse(encryptInvestorData(data,publicKey)),key),data);
});
test('newer values win while null does not hide an older observation',()=>{
 const index=investorIndex([{completed_at:'2026-11-03',stocks:[{symbol:'011420',rows:[{date:'2026-10-26',foreign_net_shares:null,individual_net_shares:-10}]}]},{completed_at:'2026-11-02',stocks:[{symbol:'011420',rows:[{date:'2026-10-26',foreign_net_shares:5,individual_net_shares:100}]}]}]);
 assert.deepEqual(index.get('011420:2026-10-26'),{individual_net_shares:-10,foreign_net_shares:5});
 assert.equal(formatInvestorShares(1200),'+1,200'); assert.equal(formatInvestorShares(-30),'-30');assert.equal(formatInvestorShares(null),'-');assert.equal(formatInvestorShares(0),'0');
});
