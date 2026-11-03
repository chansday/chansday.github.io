import { randomBytes, publicEncrypt, privateDecrypt, constants, createCipheriv, createDecipheriv } from 'node:crypto';
const AAD = Buffer.from('chansday-investor-flow-v2');
export function encryptInvestorData(data, publicKey) {
  const key=randomBytes(32), iv=randomBytes(12);
  const wrapped=publicEncrypt({key:publicKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key);
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(AAD);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]);
  return JSON.stringify({version:2,algorithm:'rsa-oaep-sha256+aes-256-gcm',wrapped_key:wrapped.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')})+'\n';
}
export function decryptInvestorData(text, privateKey) {
  const box=JSON.parse(text);
  if(box.version!==2||box.algorithm!=='rsa-oaep-sha256+aes-256-gcm')throw new Error('Unsupported encrypted file');
  const iv=Buffer.from(box.iv||'','base64'),tag=Buffer.from(box.tag||'','base64'),bytes=Buffer.from(box.ciphertext||'','base64'),wrapped=Buffer.from(box.wrapped_key||'','base64');
  if(iv.length!==12||tag.length!==16||!bytes.length||!wrapped.length)throw new Error('Invalid encrypted file');
  const key=privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},wrapped);
  const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(AAD);decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(bytes),decipher.final()]).toString('utf8'));
}
