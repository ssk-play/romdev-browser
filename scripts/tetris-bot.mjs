const shapes=[[[[0,1],[1,1],[2,1],[3,1]],[[2,0],[2,1],[2,2],[2,3]],[[0,2],[1,2],[2,2],[3,2]],[[1,0],[1,1],[1,2],[1,3]]],[[[1,0],[2,0],[1,1],[2,1]],[[1,0],[2,0],[1,1],[2,1]],[[1,0],[2,0],[1,1],[2,1]],[[1,0],[2,0],[1,1],[2,1]]],[[[1,0],[0,1],[1,1],[2,1]],[[1,0],[1,1],[2,1],[1,2]],[[0,1],[1,1],[2,1],[1,2]],[[1,0],[0,1],[1,1],[1,2]]],[[[1,0],[2,0],[0,1],[1,1]],[[1,0],[1,1],[2,1],[2,2]],[[1,1],[2,1],[0,2],[1,2]],[[0,0],[0,1],[1,1],[1,2]]],[[[0,0],[1,0],[1,1],[2,1]],[[2,0],[1,1],[2,1],[1,2]],[[0,1],[1,1],[1,2],[2,2]],[[1,0],[0,1],[1,1],[0,2]]],[[[0,0],[0,1],[1,1],[2,1]],[[1,0],[2,0],[1,1],[1,2]],[[0,1],[1,1],[2,1],[2,2]],[[1,0],[1,1],[0,2],[1,2]]],[[[2,0],[0,1],[1,1],[2,1]],[[1,0],[1,1],[1,2],[2,2]],[[0,1],[1,1],[2,1],[0,2]],[[0,0],[1,0],[1,1],[1,2]]]];
// Controller-only placement bot for real-core TETRIS DUEL verification.
export function playerBot(p){let piece=-1,plan=null,tap=false,age=0;return st=>{
 if(st[20]>0&&st[20]<4)return 0;
 if(st[44+p]!==0||st[25+p]===255)return 0;
 const rows=Array.from({length:20},(_,i)=>st[64+p*40+i*2]|st[65+p*40+i*2]<<8),type=st[27+p],rot=st[40+p],px=st[29+p]-2,py=st[42+p]-2;
 if(type>6)return 0;
 if(piece!==st[25+p]){piece=st[25+p];age=0;tap=false;let best=-Infinity;
  for(let r=0;r<4;r++)for(let x=-2;x<10;x++){
   const s=shapes[type][r],fits=y=>s.every(([dx,dy])=>x+dx>=0&&x+dx<10&&y+dy<20&&(y+dy<0||!(rows[y+dy]&(1<<(x+dx)))));
   if(!fits(py))continue;let y=py;while(fits(y+1))y++;if(s.some(([dx,dy])=>y+dy<0))continue;
   let out=rows.slice();for(const [dx,dy]of s)out[y+dy]|=1<<(x+dx);
   const cleared=out.filter(m=>m===1023).length;out=out.filter(m=>m!==1023);while(out.length<20)out.unshift(0);
   const heights=[],holes=[];for(let col=0;col<10;col++){let top=out.findIndex(m=>m&(1<<col));if(top<0)top=20;heights.push(20-top);holes.push(out.slice(top).filter(m=>!(m&(1<<col))).length);}
   const bump=heights.slice(1).reduce((a,h,i)=>a+Math.abs(h-heights[i]),0),score=cleared*7-heights.reduce((a,b)=>a+b,0)*.55-holes.reduce((a,b)=>a+b,0)*9-bump*.4;
   if(score>best){best=score;plan={x,r};}
  }
 }
 age++;if(!plan||age>160)return age%2?4:0;
 if(rot!==plan.r){tap=!tap;return tap?16:0;}
 tap=false;if(px<plan.x)return 1;if(px>plan.x)return 2;return 4;
};}
