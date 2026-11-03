const API = 'https://api.github.com/repos/chansday/chansday.github.io/git/trees/main?recursive=1';
const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
export async function importInvestorKey(pem) {
  const match = /^\s*-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----\s*$/.exec(pem);
  if (!match) throw new Error('올바른 복호화 키 파일이 아닙니다.');
  return crypto.subtle.importKey('pkcs8', decode(match[1].replace(/\s/g, '')), {name:'RSA-OAEP',hash:'SHA-256'}, false, ['decrypt']);
}
export async function decryptInvestorEnvelope(envelope, key) {
  if (envelope.version !== 2 || envelope.algorithm !== 'rsa-oaep-sha256+aes-256-gcm') throw new Error('지원하지 않는 데이터 형식입니다.');
  const raw = await crypto.subtle.decrypt({name:'RSA-OAEP'}, key, decode(envelope.wrapped_key));
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const ciphertext=decode(envelope.ciphertext), tag=decode(envelope.tag), combined=new Uint8Array(ciphertext.length+tag.length);
  combined.set(ciphertext);combined.set(tag,ciphertext.length);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(envelope.iv),additionalData:new TextEncoder().encode('chansday-investor-flow-v2'),tagLength:128},aes,combined);
  return JSON.parse(new TextDecoder().decode(plain));
}
export function investorIndex(datasets) {
  const index = new Map();
  for (const data of datasets.sort((a,b)=>String(b.completed_at).localeCompare(String(a.completed_at)))) {
    for (const stock of data.stocks || []) for (const row of stock.rows || []) {
      const key = `${stock.symbol}:${row.date}`;
      const prior = index.get(key) || {};
      for (const field of ['foreign_net_shares','individual_net_shares','institution_net_shares']) if (prior[field] == null && Number.isSafeInteger(row[field])) prior[field]=row[field];
      index.set(key,prior);
    }
  }
  return index;
}
export async function loadInvestorData(key) {
  const response=await fetch(API,{cache:'no-store'});
  if(!response.ok) throw new Error('수집 파일 목록을 불러오지 못했습니다.');
  const tree=await response.json();
  if(tree.truncated || !Array.isArray(tree.tree)) throw new Error('수집 파일 목록이 불완전합니다.');
  const paths=tree.tree.filter(x=>x.type==='blob' && /^data\/private-investor\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9.-]+\.json\.enc$/.test(x.path)).map(x=>x.path);
  const datasets=[];
  for (const path of paths) {
    const res=await fetch(`./${path}`,{cache:'no-store'});
    if(!res.ok) throw new Error('암호화된 수집 파일을 불러오지 못했습니다.');
    datasets.push(await decryptInvestorEnvelope(await res.json(),key));
  }
  return investorIndex(datasets);
}
export function formatInvestorShares(value) {
  return Number.isSafeInteger(value) ? `${value>0?'+':''}${value.toLocaleString('ko-KR')}` : '-';
}
