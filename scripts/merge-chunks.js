const fs=require('fs'), path=require('path');
const dir='output-chunks';
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
const allLessons=[]; const seen=new Set(); let dup=0, structErr=0;
files.forEach(f=>{
  let d;try{d=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));}catch(e){console.log('SKIP(손상):',f);return;}
  (d.lessons||[]).forEach(l=>{
    if(!l.node_id){structErr++;return;}
    if(seen.has(l.node_id)){dup++;return;} // 중복 node_id 첫 것만
    seen.add(l.node_id);
    allLessons.push(l);
  });
});
const merged={chunk_id:'MERGED-ALL', lessons:allLessons};
fs.writeFileSync(path.join(dir,'_MERGED-ALL.json'), JSON.stringify(merged));
let totalQ=0; allLessons.forEach(l=>totalQ+=(l.questions||[]).length);
console.log('병합 파일:', files.length);
console.log('고유 차시:', allLessons.length, '/ 중복 제외:', dup, '/ 구조오류:', structErr);
console.log('총 문항:', totalQ);
