import { useState, useMemo, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar, Cell } from "recharts";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const PALETTE = ["#10b981","#6366f1","#f59e0b","#ef4444","#3b82f6","#ec4899","#8b5cf6","#14b8a6","#f97316","#84cc16"];

const BUCKETS = [
  { label: "0–30s",   max: 0.5 },
  { label: "30s–45s", max: 0.75 },
  { label: "45s–1m",  max: 1 },
  { label: "1m–1.5m", max: 1.5 },
  { label: "1.5m–2m", max: 2 },
  { label: "2m–2.5m", max: 2.5 },
  { label: "2.5m–3m", max: 3 },
  { label: "3–4m",    max: 4 },
  { label: "4–5m",    max: 5 },
  { label: "5m+",     max: Infinity },
];

// ─── PARSING HELPERS ──────────────────────────────────────────────────────────

function detectInstructorAndClass(text) {
  const m = text.match(/\[(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}\]\s*(\w+)\s*->\s*(\d+):/m);
  return m ? { instructor: m[2], classId: m[3] } : null;
}

function extractFirstColumn(text) {
  const results = [];
  let i = 0;
  while (i < text.length) {
    let cell = "";
    if (text[i] === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === '"' && text[i+1] === '"') { cell += '"'; i += 2; }
        else if (text[i] === '"') { i++; break; }
        else { cell += text[i++]; }
      }
    } else {
      while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') cell += text[i++];
    }
    results.push(cell.trim());
    while (i < text.length && text[i] !== '\n') i++;
    if (i < text.length) i++;
  }
  return results;
}

function parseLog(text, instructor, classId) {
  const lines = extractFirstColumn(text).filter(l => l.startsWith("["));
  const re = new RegExp(`^\\[(\\d{4}-\\d{2}-\\d{2})\\s+(\\d{2}:\\d{2}:\\d{2})\\]\\s*${instructor}\\s*->\\s*${classId}:\\s*(.*)`);
  const data = [];
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const [, date, time, body] = m;
    const ts = new Date(`${date}T${time}`);
    const h = ts.getHours(), min = ts.getMinutes();
    if (h < 19 || (h === 19 && min < 29) || h >= 21) continue;
    data.push({ ts, date, raw: `${date} ${time}`, msg: body.trim() });
  }
  return data.sort((a, b) => a.ts - b.ts);
}

function countByDate(text, instructor, classId) {
  const lines = extractFirstColumn(text).filter(l => l.startsWith("["));
  const re = new RegExp(`^\\[(\\d{4}-\\d{2}-\\d{2})\\s+(\\d{2}:\\d{2}:\\d{2})\\]\\s*${instructor}\\s*->\\s*${classId}:`);
  const counts = {};
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return counts;
}

function computeGaps(rows) {
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const diff = (rows[i].ts - rows[i-1].ts) / 1000;
    if (diff > 0 && diff < 7200)
      gaps.push({ diff, diffMin: +(diff/60).toFixed(2), from: rows[i-1].raw, to: rows[i].raw, fromMsg: rows[i-1].msg });
  }
  return gaps;
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  return s[Math.min(Math.floor(p/100*s.length), s.length-1)];
}

function buildHistogram(gaps) {
  const counts = BUCKETS.map(b => ({ label: b.label, count: 0 }));
  for (const g of gaps) {
    for (let i = 0; i < BUCKETS.length; i++) {
      if (g.diffMin <= BUCKETS[i].max) { counts[i].count++; break; }
    }
  }
  return counts;
}

function computeStats(rows, gaps) {
  const diffs = gaps.map(g => g.diffMin);
  if (!diffs.length) return null;
  const avg = diffs.reduce((s,x)=>s+x,0)/diffs.length;
  const variance = diffs.reduce((s,x)=>s+(x-avg)**2,0)/diffs.length;
  const byDate = {};
  for (const r of rows) {
    const d = r.raw.split(" ")[0];
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(r.ts);
  }
  const mpms = Object.values(byDate).map(ts => {
    const dur = (ts[ts.length-1]-ts[0])/60000;
    return dur > 0 ? ts.length/dur : 0;
  });
  return {
    total: rows.length, totalGaps: gaps.length,
    median: +pct(diffs,50).toFixed(2), p90: +pct(diffs,90).toFixed(2),
    avg: +avg.toFixed(2), stdDev: +Math.sqrt(variance).toFixed(2),
    avgMsgPerMin: +(mpms.reduce((s,x)=>s+x,0)/mpms.length).toFixed(2),
    longWaits: gaps.filter(g=>g.diffMin>5).length,
    longWaitPct: +((gaps.filter(g=>g.diffMin>5).length/gaps.length)*100).toFixed(1),
  };
}

function buildSessionData(gaps) {
  const byDate = {};
  for (const g of gaps) {
    const d = g.from.split(" ")[0];
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(g.diffMin);
  }
  return Object.entries(byDate).map(([date, diffs]) => ({
    date, median: +pct(diffs,50).toFixed(2), p90: +pct(diffs,90).toFixed(2),
  })).sort((a,b)=>a.date.localeCompare(b.date));
}

// ─── SHARED COMPONENTS ────────────────────────────────────────────────────────

function FileInput({ label, multiple, onFiles }) {
  return (
    <div style={{border:"2px dashed #10b981",borderRadius:10,padding:"16px 20px",background:"#f0fdf4",marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
        <span style={{fontSize:22}}>📂</span>
        <span style={{fontSize:13,color:"#555"}}>{label}</span>
      </div>
      <input type="file" accept=".csv,.txt" multiple={multiple}
        onChange={e=>{ const f=Array.from(e.target.files); if(f.length) onFiles(f); e.target.value=""; }}
        style={{fontSize:13,cursor:"pointer",display:"block"}}/>
    </div>
  );
}

function GapTable({ gaps, lo, hi }) {
  const filtered = gaps.filter(g=>g.diffMin>lo&&g.diffMin<=hi).sort((a,b)=>b.diffMin-a.diffMin);
  return (
    <div style={{overflowX:"auto",maxHeight:300,overflowY:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead style={{position:"sticky",top:0,background:"#f9fafb"}}>
          <tr>{["#","Gap","From","To","Message"].map(h=>(
            <th key={h} style={{padding:"6px 8px",textAlign:"left",borderBottom:"2px solid #ddd",fontWeight:600,whiteSpace:"nowrap"}}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {filtered.length===0
            ?<tr><td colSpan={5} style={{padding:12,color:"#999",textAlign:"center"}}>No gaps in this range.</td></tr>
            :filtered.map((g,i)=>(
              <tr key={i} style={{borderBottom:"1px solid #eee"}}>
                <td style={{padding:"5px 8px",color:"#999"}}>{i+1}</td>
                <td style={{padding:"5px 8px",fontWeight:700}}>{g.diffMin}m</td>
                <td style={{padding:"5px 8px",color:"#555",whiteSpace:"nowrap"}}>{g.from}</td>
                <td style={{padding:"5px 8px",color:"#555",whiteSpace:"nowrap"}}>{g.to}</td>
                <td style={{padding:"5px 8px",color:"#444",maxWidth:260,wordBreak:"break-word"}}>{g.fromMsg||"—"}</td>
              </tr>
            ))
          }
        </tbody>
      </table>
    </div>
  );
}

// ─── GAP ANALYZER ─────────────────────────────────────────────────────────────

function GapPanel({ instructor, classId, color, gaps, stats, hist, sessionData }) {
  const [view, setView] = useState("histogram");
  const tabs = [{id:"histogram",label:"Distribution"},{id:"sessions",label:"By Session"},{id:"gaps_3_4",label:"3–4m"},{id:"gaps_4_5",label:"4–5m"},{id:"gaps_5plus",label:"5m+"}];
  if (!stats) return null;
  return (
    <div style={{border:`1px solid ${color}44`,borderRadius:10,padding:14,flex:"1 1 300px",minWidth:0}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
        <span style={{width:10,height:10,borderRadius:"50%",background:color,display:"inline-block"}}/>
        <strong>{instructor}</strong><span style={{fontSize:12,color:"#999",marginLeft:4}}>class {classId} · {stats.total} msgs</span>
      </div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
        {[{l:"Median",v:`${stats.median}m`},{l:"P90",v:`${stats.p90}m`},{l:"Msg/Min",v:stats.avgMsgPerMin},{l:"Std Dev",v:`${stats.stdDev}m`,c:stats.stdDev>3?"#ef4444":stats.stdDev>1.5?"#f59e0b":color},{l:">5min",v:`${stats.longWaitPct}%`,c:stats.longWaitPct>20?"#ef4444":"#f59e0b"}].map(k=>(
          <div key={k.l} style={{flex:"1 1 70px",background:"#f9fafb",borderRadius:6,padding:"6px 8px",borderTop:`3px solid ${k.c||color}`}}>
            <div style={{fontSize:10,color:"#888"}}>{k.l}</div>
            <div style={{fontSize:15,fontWeight:700,color:k.c||color}}>{k.v}</div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",gap:5,marginBottom:10,flexWrap:"wrap"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setView(t.id)}
            style={{padding:"4px 10px",borderRadius:5,border:"1px solid #ddd",cursor:"pointer",fontSize:11,
              background:view===t.id?color:"#f5f5f5",color:view===t.id?"#fff":"#333",fontWeight:view===t.id?600:400}}>{t.label}</button>
        ))}
      </div>
      {view==="histogram"&&(
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={hist} margin={{top:2,right:5,left:-15,bottom:30}}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee"/>
            <XAxis dataKey="label" tick={{fontSize:8}} interval={0} angle={-35} textAnchor="end"/>
            <YAxis tick={{fontSize:10}}/><Tooltip/>
            <Bar dataKey="count" fill={color} radius={[2,2,0,0]}/>
          </BarChart>
        </ResponsiveContainer>
      )}
      {view==="sessions"&&(
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={sessionData} margin={{top:2,right:5,left:-15,bottom:30}}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee"/>
            <XAxis dataKey="date" tick={{fontSize:8}} angle={-35} textAnchor="end"/>
            <YAxis tick={{fontSize:10}}/><Tooltip/><Legend/>
            <Line type="monotone" dataKey="median" name="Median" stroke={color} strokeWidth={2} dot={{r:3}}/>
            <Line type="monotone" dataKey="p90" name="P90" stroke={color} strokeWidth={2} strokeDasharray="5 5" dot={{r:3}} opacity={0.6}/>
          </LineChart>
        </ResponsiveContainer>
      )}
      {view==="gaps_3_4"&&<GapTable gaps={gaps} lo={3} hi={4}/>}
      {view==="gaps_4_5"&&<GapTable gaps={gaps} lo={4} hi={5}/>}
      {view==="gaps_5plus"&&<GapTable gaps={gaps} lo={5} hi={Infinity}/>}
    </div>
  );
}

function GapComparison({ instructors }) {
  const [metric, setMetric] = useState("median");
  const metrics = [{id:"median",label:"Median Gap"},{id:"p90",label:"P90 Gap"},{id:"avgMsgPerMin",label:"Msg/Min"},{id:"stdDev",label:"Std Dev"}];
  const barData = instructors.map(i => ({ name: i.instructor, value: i.stats[metric], color: i.color }));
  return (
    <div style={{border:"1px solid #e5e7eb",borderRadius:10,padding:16}}>
      <strong>Comparison</strong>
      <div style={{display:"flex",gap:8,margin:"10px 0",flexWrap:"wrap"}}>
        {metrics.map(m=>(
          <button key={m.id} onClick={()=>setMetric(m.id)}
            style={{padding:"4px 12px",borderRadius:5,border:"1px solid #ddd",cursor:"pointer",fontSize:12,
              background:metric===m.id?"#334155":"#f5f5f5",color:metric===m.id?"#fff":"#333"}}>{m.label}</button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={barData} margin={{top:20,right:20,left:0,bottom:5}}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eee"/>
          <XAxis dataKey="name" tick={{fontSize:12}}/><YAxis tick={{fontSize:11}}/><Tooltip/>
          <Bar dataKey="value" radius={[4,4,0,0]} label={{position:"top",fontSize:11}}>
            {barData.map((e,i)=><Cell key={i} fill={e.color}/>)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,marginTop:12}}>
        <thead><tr style={{background:"#f8fafc"}}>
          <th style={{padding:"8px 12px",textAlign:"left",borderBottom:"2px solid #ddd"}}>Metric</th>
          {instructors.map(i=><th key={i.instructor} style={{padding:"8px 12px",textAlign:"left",borderBottom:"2px solid #ddd",color:i.color}}>{i.instructor}</th>)}
        </tr></thead>
        <tbody>{metrics.map(m=>(
          <tr key={m.id} style={{borderBottom:"1px solid #eee"}}>
            <td style={{padding:"8px 12px",fontWeight:500}}>{m.label}</td>
            {instructors.map(inst=>{
              const vals = instructors.map(i=>i.stats[m.id]);
              const best = m.id==="avgMsgPerMin"?Math.max(...vals):Math.min(...vals);
              const isBest = inst.stats[m.id]===best;
              return <td key={inst.instructor} style={{padding:"8px 12px",fontWeight:isBest?700:400,color:isBest?inst.color:"inherit"}}>{inst.stats[m.id]}{isBest?" ✓":""}</td>;
            })}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function GapAnalyzer() {
  const [files, setFiles] = useState({});
  const analyzed = useMemo(() => {
    return Object.entries(files).map(([slot, { text, instructor, classId }], idx) => {
      const rows = parseLog(text, instructor, classId);
      const gaps = computeGaps(rows);
      const stats = computeStats(rows, gaps);
      return { slot, instructor, classId, color: PALETTE[idx], rows, gaps, stats, hist: buildHistogram(gaps), sessionData: buildSessionData(gaps) };
    });
  }, [files]);
  const handleFile = (slot, file) => {
    file.text().then(text => {
      const d = detectInstructorAndClass(text);
      if (!d) { alert("Could not detect instructor/class."); return; }
      setFiles(prev => ({ ...prev, [slot]: { text, ...d } }));
    });
  };
  return (
    <div>
      <p style={{fontSize:13,color:"#666",marginBottom:16}}>Upload up to two instructor message logs to compare gap metrics.</p>
      <div style={{display:"flex",gap:16,flexWrap:"wrap",marginBottom:8}}>
        <div style={{flex:"1 1 200px"}}>
          <FileInput label="Instructor A" multiple={false} onFiles={f=>handleFile("A",f[0])}/>
          {files.A&&<div style={{fontSize:12,color:PALETTE[0],marginBottom:8}}>✓ {files.A.instructor} · class {files.A.classId}</div>}
        </div>
        <div style={{flex:"1 1 200px"}}>
          <FileInput label="Instructor B (optional)" multiple={false} onFiles={f=>handleFile("B",f[0])}/>
          {files.B&&<div style={{fontSize:12,color:PALETTE[1],marginBottom:8}}>✓ {files.B.instructor} · class {files.B.classId}</div>}
        </div>
      </div>
      <div style={{display:"flex",gap:16,flexWrap:"wrap",marginBottom:16}}>
        {analyzed.map(a=><GapPanel key={a.slot} {...a}/>)}
      </div>
      {analyzed.length===2&&<GapComparison instructors={analyzed}/>}
    </div>
  );
}

// ─── SESSION ANALYZER ─────────────────────────────────────────────────────────

function SessionCard({ session: s, index: i, color }) {
  const [view, setView] = useState("histogram");
  if (!s.stats) return null;
  return (
    <div style={{border:`1px solid ${color}44`,borderRadius:10,padding:14}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
        <span style={{width:10,height:10,borderRadius:"50%",background:color,display:"inline-block"}}/>
        <strong>Session {i+1} — {s.date}</strong>
        <span style={{fontSize:11,color:"#999",marginLeft:4}}>{s.stats.total} msgs</span>
      </div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
        {[{l:"Median",v:`${s.stats.median}m`},{l:"P90",v:`${s.stats.p90}m`},{l:"Msg/Min",v:s.stats.avgMsgPerMin},{l:"Std Dev",v:`${s.stats.stdDev}m`,c:s.stats.stdDev>3?"#ef4444":s.stats.stdDev>1.5?"#f59e0b":color},{l:">5min",v:`${s.stats.longWaitPct}%`,c:s.stats.longWaitPct>20?"#ef4444":"#f59e0b"}].map(k=>(
          <div key={k.l} style={{flex:"1 1 60px",background:"#f9fafb",borderRadius:6,padding:"6px 8px",borderTop:`3px solid ${k.c||color}`}}>
            <div style={{fontSize:10,color:"#888"}}>{k.l}</div>
            <div style={{fontSize:14,fontWeight:700,color:k.c||color}}>{k.v}</div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",gap:5,marginBottom:10,flexWrap:"wrap"}}>
        {[{id:"histogram",label:"Dist"},{id:"gaps_3_4",label:"3–4m"},{id:"gaps_4_5",label:"4–5m"},{id:"gaps_5plus",label:"5m+"}].map(t=>(
          <button key={t.id} onClick={()=>setView(t.id)}
            style={{padding:"4px 8px",borderRadius:5,border:"1px solid #ddd",cursor:"pointer",fontSize:11,
              background:view===t.id?color:"#f5f5f5",color:view===t.id?"#fff":"#333"}}>{t.label}</button>
        ))}
      </div>
      {view==="histogram"&&(
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={s.hist} margin={{top:2,right:5,left:-15,bottom:28}}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee"/>
            <XAxis dataKey="label" tick={{fontSize:8}} interval={0} angle={-35} textAnchor="end"/>
            <YAxis tick={{fontSize:10}}/><Tooltip/>
            <Bar dataKey="count" fill={color} radius={[2,2,0,0]}/>
          </BarChart>
        </ResponsiveContainer>
      )}
      {view==="gaps_3_4"&&<GapTable gaps={s.gaps} lo={3} hi={4}/>}
      {view==="gaps_4_5"&&<GapTable gaps={s.gaps} lo={4} hi={5}/>}
      {view==="gaps_5plus"&&<GapTable gaps={s.gaps} lo={5} hi={Infinity}/>}
    </div>
  );
}

function SessionAnalyzer() {
  const [fileData, setFileData] = useState(null);
  const [metric, setMetric] = useState("median");
  const metrics = [{id:"median",label:"Median"},{id:"p90",label:"P90"},{id:"msgPerMin",label:"Msg/Min"},{id:"stdDev",label:"Std Dev"},{id:"longWaitPct",label:">5min %"}];

  const sessions = useMemo(() => {
    if (!fileData) return [];
    const { text, instructor, classId } = fileData;
    const allRows = parseLog(text, instructor, classId);
    const byDate = {};
    for (const row of allRows) {
      if (!byDate[row.date]) byDate[row.date] = [];
      byDate[row.date].push(row);
    }
    return Object.entries(byDate).sort(([a],[b])=>a.localeCompare(b)).map(([date, rows]) => {
      const gaps = computeGaps(rows);
      return { date, rows, gaps, stats: computeStats(rows, gaps), hist: buildHistogram(gaps) };
    });
  }, [fileData]);

  const overviewData = useMemo(() => sessions.map((s,i) => ({
    session: `S${i+1} ${s.date.slice(5)}`,
    median: s.stats?.median,
    p90: s.stats?.p90,
    msgPerMin: s.stats?.avgMsgPerMin,
    stdDev: s.stats?.stdDev,
    longWaitPct: s.stats?.longWaitPct,
  })), [sessions]);

  return (
    <div>
      <p style={{fontSize:13,color:"#666",marginBottom:16}}>Upload a full-course log to analyze each session individually.</p>
      <FileInput label="Full course message log (all sessions)" multiple={false} onFiles={f=>{
        f[0].text().then(text=>{
          const d = detectInstructorAndClass(text);
          if (!d) { alert("Could not detect instructor/class."); return; }
          setFileData({ text, ...d });
        });
      }}/>
      {fileData&&<p style={{fontSize:12,color:"#666",marginBottom:12}}>{fileData.instructor} · class {fileData.classId} · {sessions.length} sessions</p>}
      {sessions.length>0&&(
        <>
          <div style={{border:"1px solid #e5e7eb",borderRadius:10,padding:16,marginBottom:16}}>
            <strong>All Sessions Overview</strong>
            <div style={{display:"flex",gap:8,margin:"10px 0",flexWrap:"wrap"}}>
              {metrics.map(m=>(
                <button key={m.id} onClick={()=>setMetric(m.id)}
                  style={{padding:"4px 12px",borderRadius:5,border:"1px solid #ddd",cursor:"pointer",fontSize:12,
                    background:metric===m.id?"#334155":"#f5f5f5",color:metric===m.id?"#fff":"#333"}}>{m.label}</button>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={overviewData} margin={{top:25,right:20,left:0,bottom:5}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee"/>
                <XAxis dataKey="session" tick={{fontSize:10}}/><YAxis tick={{fontSize:11}}/><Tooltip/>
                <Bar dataKey={metric} radius={[4,4,0,0]} label={{position:"top",fontSize:10}}>
                  {overviewData.map((_,i)=><Cell key={i} fill={PALETTE[i%PALETTE.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))",gap:16}}>
            {sessions.map((s,i)=>(
              <SessionCard key={s.date} session={s} index={i} color={PALETTE[i%PALETTE.length]}/>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── MESSAGE COUNTER ──────────────────────────────────────────────────────────

function MessageCounter() {
  const accumulated = useRef([]);
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState("");

  const handleFiles = async (files) => {
    setStatus(`Reading ${files.length} file(s)...`);
    for (const file of files) {
      try {
        const text = await file.text();
        const d = detectInstructorAndClass(text);
        if (!d) continue;
        const counts = countByDate(text, d.instructor, d.classId);
        for (const [date, count] of Object.entries(counts)) {
          const exists = accumulated.current.find(x => x.instructor===d.instructor && x.date===date);
          if (!exists) accumulated.current.push({ date, instructor: d.instructor, classId: d.classId, count, lesson: 0 });
        }
      } catch(e) { console.error(e); }
    }
    const instructors = [...new Set(accumulated.current.map(r=>r.instructor))];
    for (const inst of instructors) {
      const rows = accumulated.current.filter(r=>r.instructor===inst).sort((a,b)=>a.date.localeCompare(b.date));
      rows.forEach((r,i)=>r.lesson=i+1);
    }
    setResults([...accumulated.current]);
    setStatus(`Loaded ${accumulated.current.length} lesson(s) across ${instructors.length} instructor(s).`);
  };

  const instructors = [...new Set(results.map(r=>r.instructor))];
  const instColors = Object.fromEntries(instructors.map((inst,i)=>[inst,PALETTE[i%PALETTE.length]]));
  const maxLesson = Math.max(0,...results.map(r=>r.lesson||0));
  const chartData = Array.from({length:maxLesson},(_,i)=>{
    const row = { lesson:`L${i+1}` };
    const counts = [];
    for (const inst of instructors) {
      const match = results.find(r=>r.instructor===inst&&r.lesson===i+1);
      row[inst] = match?match.count:null;
      if (match) counts.push(match.count);
    }
    row["Average"] = counts.length?+(counts.reduce((s,x)=>s+x,0)/counts.length).toFixed(1):null;
    return row;
  });

  return (
    <div>
      <p style={{fontSize:13,color:"#666",marginBottom:16}}>Upload full-course CSVs (one per instructor) to count messages per lesson.</p>
      <FileInput label="Select one or more CSV files" multiple={true} onFiles={handleFiles}/>
      {status&&<div style={{fontSize:12,color:"#10b981",marginBottom:12,fontWeight:600}}>{status}</div>}
      {results.length>0&&(
        <>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:16}}>
            {instructors.map(inst=>{
              const rows=results.filter(r=>r.instructor===inst);
              const total=rows.reduce((s,r)=>s+r.count,0);
              return (
                <div key={inst} style={{flex:"1 1 140px",border:"1px solid #e5e7eb",borderRadius:8,padding:"10px 12px",borderTop:`4px solid ${instColors[inst]}`}}>
                  <div style={{fontSize:12,fontWeight:700,color:instColors[inst],marginBottom:2}}>{inst}</div>
                  <div style={{fontSize:20,fontWeight:700}}>{total}</div>
                  <div style={{fontSize:11,color:"#999"}}>{rows.length} lessons · avg {(total/rows.length).toFixed(1)}/lesson</div>
                </div>
              );
            })}
          </div>
          <div style={{border:"1px solid #e5e7eb",borderRadius:10,padding:16,marginBottom:16}}>
            <strong style={{fontSize:14}}>Messages per Lesson</strong>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData} margin={{top:25,right:20,left:0,bottom:5}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee"/>
                <XAxis dataKey="lesson" tick={{fontSize:11}}/><YAxis tick={{fontSize:11}}/><Tooltip/><Legend/>
                {instructors.map(inst=><Bar key={inst} dataKey={inst} fill={instColors[inst]} radius={[3,3,0,0]}/>)}
                <Bar dataKey="Average" fill="#334155" radius={[3,3,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div style={{border:"1px solid #e5e7eb",borderRadius:10,overflow:"hidden",marginBottom:12,overflowX:"auto"}}>
            <div style={{padding:"10px 14px",background:"#1e293b"}}>
              <strong style={{color:"#fff"}}>Lesson Comparison</strong>
            </div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:400}}>
              <thead style={{background:"#f8fafc"}}>
                <tr>
                  <th style={{padding:"8px 12px",textAlign:"left",borderBottom:"2px solid #ddd"}}>Lesson</th>
                  <th style={{padding:"8px 12px",textAlign:"left",borderBottom:"2px solid #ddd",background:"#f1f5f9"}}>Avg</th>
                  {instructors.map(inst=><th key={inst} style={{padding:"8px 12px",textAlign:"left",borderBottom:"2px solid #ddd",color:instColors[inst]}}>{inst}</th>)}
                </tr>
              </thead>
              <tbody>
                {Array.from({length:maxLesson},(_,i)=>{
                  const lesson=i+1;
                  const matches=results.filter(r=>r.lesson===lesson);
                  if(!matches.length) return null;
                  const avg=matches.reduce((s,r)=>s+r.count,0)/matches.length;
                  return (
                    <tr key={lesson} style={{borderBottom:"1px solid #eee"}}>
                      <td style={{padding:"7px 12px",fontWeight:600}}>L{lesson}</td>
                      <td style={{padding:"7px 12px",fontWeight:700,background:"#f8fafc"}}>{avg.toFixed(1)}</td>
                      {instructors.map(inst=>{
                        const match=results.find(r=>r.instructor===inst&&r.lesson===lesson);
                        const val=match?match.count:null;
                        const diff=val!==null?val-avg:null;
                        return (
                          <td key={inst} style={{padding:"7px 12px"}}>
                            {val!==null
                              ?<span><strong>{val}</strong><span style={{fontSize:11,marginLeft:6,color:diff>0?"#10b981":diff<0?"#ef4444":"#999"}}>{diff>0?`+${diff.toFixed(0)}`:diff<0?diff.toFixed(0):"—"}</span></span>
                              :<span style={{color:"#ccc"}}>—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button onClick={()=>{ accumulated.current=[]; setResults([]); setStatus(""); }}
            style={{padding:"6px 14px",borderRadius:6,border:"1px solid #fca5a5",background:"#fef2f2",color:"#ef4444",cursor:"pointer",fontSize:12}}>
            Clear all
          </button>
        </>
      )}
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id:"gap", label:"📊 Gap Analyzer" },
  { id:"session", label:"🗓 Session Analyzer" },
  { id:"counter", label:"🔢 Message Counter" },
];

export default function App() {
  const [tab, setTab] = useState("gap");
  return (
    <div style={{fontFamily:"sans-serif",background:"var(--bg-primary,#fff)",color:"var(--text-primary,#111)",minHeight:"100vh"}}>
      <div style={{background:"#1e293b",padding:"14px 20px"}}>
        <h1 style={{margin:0,fontSize:18,color:"#fff",fontWeight:700}}>Instructor Analytics</h1>
        <p style={{margin:"2px 0 0",fontSize:12,color:"#94a3b8"}}>Message gap analysis · Session breakdown · Lesson message counts</p>
      </div>
      <div style={{display:"flex",borderBottom:"2px solid #e5e7eb",background:"#f8fafc"}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{padding:"12px 20px",border:"none",borderBottom:tab===t.id?"3px solid #10b981":"3px solid transparent",
              cursor:"pointer",fontSize:13,fontWeight:tab===t.id?700:400,
              background:"transparent",color:tab===t.id?"#10b981":"#555",marginBottom:-2}}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{padding:20}}>
        {tab==="gap"&&<GapAnalyzer/>}
        {tab==="session"&&<SessionAnalyzer/>}
        {tab==="counter"&&<MessageCounter/>}
      </div>
    </div>
  );
}