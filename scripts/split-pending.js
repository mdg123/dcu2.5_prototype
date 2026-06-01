const fs=require('fs'), path=require('path');
const dir='input-chunks-micro';
const pending=['m06-초1-1-수와연산','m08-초1-2-도형과측정','m09-초1-2-도형의방정식','m13-초1-2-집합과명제','m16-초2-1-변화와관계','m17-초2-1-수와연산','m19-초2-2-도형과측정','m23-초3-1-도형과측정','m24-초3-1-변화와관계','m25-초3-1-수와연산-p1','m27-초3-2-도형과측정-p1','m29-초3-2-수와연산','m33-초4-1-수와연산','m35-초4-2-도형과측정','m36-초4-2-수와연산','m38-초5-1-도형과측정','m40-초5-1-수와연산','m41-초5-2-도형과측정','m42-초5-2-수와연산','m44-초6-1-도형과측정','m46-초6-1-수와연산','m48-초6-2-도형과측정'];
let cnt=0;
pending.forEach(name=>{
  const f=path.join(dir, name+'.input.json');
  if(!fs.existsSync(f)){console.log('MISSING:',name);return;}
  const d=JSON.parse(fs.readFileSync(f,'utf8'));
  const h=Math.ceil(d.length/2);
  const base=name.replace(/-p1$/,''); // m25-초3-1-수와연산-p1 → base
  fs.writeFileSync(path.join(dir, base+'-A.input.json'), JSON.stringify(d.slice(0,h),null,2));
  fs.writeFileSync(path.join(dir, base+'-B.input.json'), JSON.stringify(d.slice(h),null,2));
  console.log(base+'-A:'+h+' / '+base+'-B:'+(d.length-h));
  cnt++;
});
console.log('---\nsplit',cnt,'chunks →',cnt*2,'sub-batches');
