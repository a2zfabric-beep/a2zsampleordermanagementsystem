'use client';

import React, { useState, useEffect } from 'react';
import { 
  CheckCircle2, Circle, AlertCircle, Lock, Truck, Palette, 
  Printer, Scissors, ChevronDown, ChevronUp, Download, Trash2, Check, XCircle, Timer, FileText
} from 'lucide-react';

interface StageData {
  status: 'pending' | 'in_progress' | 'completed' | 'na';
  assignedDays: number;
  startDate?: string;
  actualDate?: string;
  poConfirmed?: boolean;
  mode?: 'stock' | 'vendor' | null;
}

export default function ProductionWorkflow({ order }: { order: any }) {
  const [activePrintStage, setActivePrintStage] = useState<any>(null);
  const [expandedStage, setExpandedStage] = useState<number | null>(1);
  const [stages, setStages] = useState<Record<number, StageData>>({
    1: { status: 'pending', assignedDays: 0, startDate: order?.created_at, mode: null },
    2: { status: 'pending', assignedDays: 0 },
    3: { status: 'pending', assignedDays: 0 },
    4: { status: 'pending', assignedDays: 0 },
    5: { status: 'pending', assignedDays: 0 },
  });

  const [fabricRows, setFabricRows] = useState<any[]>([]);
  const [stageConfigs, setStageConfigs] = useState<Record<number, any[]>>({});
  const [samplingStyles, setSamplingStyles] = useState<any[]>([]);

  useEffect(() => {
    if (order?.styles) {
      const groups: Record<string, any> = {};
      order.styles.forEach((s: any) => {
        const key = `${s.fabric}-${s.color_name}`;
        if (groups[key]) groups[key].qty += s.quantity;
        else groups[key] = { fabric: s.fabric || '', color: s.color_name || '', qty: s.quantity || 1, vendor: '' };
      });
      setFabricRows(Object.values(groups));
      
      const initialConfigs: any = {};
      [2,3,4].forEach(id => {
        initialConfigs[id] = order.styles.map((s: any) => ({
          item_number: s.item_number,
          fabric: s.fabric || '',
          color: s.color_name || '',
          technique: '',
          qty: s.quantity,
          vendor: '' 
        }));
      });
      setStageConfigs(initialConfigs);
      setSamplingStyles(order.styles.map((s: any) => ({ ...s, notes: '', isDone: false })));
    }
  }, [order]);

  if (!order) return <div className="p-10 text-center animate-pulse font-black text-gray-400 uppercase">Awaiting Data...</div>;

  const totalBudgetDays = React.useMemo(() => {
    if (!order.delivery_date || !order.created_at) return 0;
    const start = new Date(order.created_at);
    const end = new Date(order.delivery_date);
    // Reset hours to compare full days
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    const diffTime = end.getTime() - start.getTime();
    return Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
  }, [order.delivery_date, order.created_at]);

  const handleStageUpdate = (id: number, updates: Partial<StageData>) => {
    if (updates.assignedDays !== undefined) {
      const others = Object.entries(stages).filter(([k]) => Number(k) !== id).reduce((s, [_, v]) => s + v.assignedDays, 0);
      if (others + updates.assignedDays > totalBudgetDays) {
        alert(`Limit Exceeded: Only ${totalBudgetDays - others} days remaining.`);
        return;
      }
    }
    const newStages = { ...stages, [id]: { ...stages[id], ...updates } };
    if (updates.status === 'completed' || updates.status === 'na') {
      const nextId = id + 1;
      if (nextId <= 5) {
        newStages[nextId] = { ...newStages[nextId], startDate: new Date().toISOString().split('T')[0] };
        setExpandedStage(nextId);
      }
    }
    setStages(newStages);
  };

  const triggerPrint = (stageId: number, title: string) => {
    setActivePrintStage({ id: stageId, title });
    setTimeout(() => { window.print(); }, 100);
  };

  const isLocked = (id: number) => id !== 1 && stages[id-1].status !== 'completed' && stages[id-1].status !== 'na';

  return (
    <div className="space-y-6 pb-20 no-scrollbar">
      {/* BUDGET HEADER */}
      <div className="bg-white rounded-[2.5rem] border-2 border-gray-100 p-8 shadow-sm no-print">
        <div className="flex flex-col md:flex-row justify-between items-center gap-10">
          <div className="flex items-center gap-5">
             <div className="w-14 h-14 bg-blue-600 rounded-3xl flex items-center justify-center text-white shadow-xl shadow-blue-600/20"><Timer size={28} /></div>
             <div><p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em]">Project Capacity</p><h2 className="text-2xl font-black text-gray-900">{totalBudgetDays} Days</h2></div>
          </div>
          <div className="flex gap-12">
             <div className="text-center"><p className="text-[10px] font-black text-gray-400 uppercase">Assigned</p><p className="text-xl font-black text-gray-900">{Object.values(stages).reduce((a,b)=>a+b.assignedDays,0)}d</p></div>
             <div className="text-center"><p className="text-[10px] font-black text-gray-400 uppercase">Buffer</p><p className={`text-xl font-black ${totalBudgetDays - Object.values(stages).reduce((a,b)=>a+b.assignedDays,0) < 0 ? 'text-red-500' : 'text-emerald-500'}`}>{totalBudgetDays - Object.values(stages).reduce((a,b)=>a+b.assignedDays,0)}d</p></div>
          </div>
        </div>
      </div>

      <div className="space-y-4 no-print">
        {/* STAGE 1: FABRIC */}
        <StageCard title="Fabric Procurement" icon={<Truck size={20}/>} stage={stages[1]} expanded={expandedStage === 1} onToggle={() => setExpandedStage(1)} mandatory>
          <div className="space-y-6">
            {!stages[1].mode ? (
              <div className="flex gap-4">
                <button onClick={() => handleStageUpdate(1, { mode: 'stock', assignedDays: 0 })} className="flex-1 py-5 bg-emerald-600 text-white rounded-2xl font-black uppercase text-xs shadow-lg">Existing Stock</button>
                <button onClick={() => handleStageUpdate(1, { mode: 'vendor' })} className="flex-1 py-5 bg-blue-600 text-white rounded-2xl font-black uppercase text-xs shadow-lg">Order From Vendor</button>
              </div>
            ) : (
              <div className="space-y-6 animate-in fade-in">
                <div className="flex items-end gap-4 p-5 bg-gray-50 rounded-2xl border border-gray-100">
                  <div className="flex-1"><label className="text-[10px] font-black text-gray-400 uppercase block mb-1">Budget Days</label><input type="number" disabled={stages[1].mode === 'stock'} className="w-24 p-3 bg-white border border-gray-200 rounded-xl font-black text-sm disabled:opacity-50" value={stages[1].assignedDays} onChange={(e) => handleStageUpdate(1, { assignedDays: Number(e.target.value) })}/></div>
                </div>
                <table className="w-full text-left">
                  <thead className="text-[10px] font-black text-gray-400 uppercase border-b border-gray-100">
                    <tr><th className="pb-3">Fabric</th><th className="pb-3">Color</th><th className="pb-3">Qty</th>{stages[1].mode === 'vendor' && <th className="pb-3">Vendor</th>}</tr>
                  </thead>
                  <tbody>
                    {fabricRows.map((f, i) => (
                      <tr key={i} className="border-b border-gray-50 last:border-0">
                        <td className="py-3 pr-2 font-bold text-xs uppercase">{f.fabric}</td>
                        <td className="pr-2 font-bold text-xs uppercase">{f.color}</td>
                        <td className="pr-2"><input type="number" className="w-16 p-2 bg-white border border-gray-100 rounded-lg text-xs font-bold" value={f.qty} onChange={e => {const r=[...fabricRows]; r[i].qty=Number(e.target.value); setFabricRows(r)}}/></td>
                        {stages[1].mode === 'vendor' && <td><input className="w-full p-2 bg-white border border-gray-100 rounded-lg text-xs font-bold" placeholder="Vendor..." value={f.vendor} onChange={e => {const r=[...fabricRows]; r[i].vendor=e.target.value; setFabricRows(r)}}/></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex justify-between items-center pt-6 border-t">
                  <button onClick={() => handleStageUpdate(1, {mode: null, status: 'pending', poConfirmed: false})} className="text-[10px] font-black text-gray-400 uppercase underline">Reset Choice</button>
                  <div className="flex gap-3">
                    {stages[1].mode === 'vendor' && !stages[1].poConfirmed ? (
                       <button onClick={() => handleStageUpdate(1, { poConfirmed: true })} className="px-10 py-3 bg-blue-600 text-white rounded-xl font-black text-[10px] uppercase shadow-lg">Confirm PO</button>
                    ) : (
                      <>
                        {stages[1].mode === 'vendor' && <button onClick={() => triggerPrint(1, 'Fabric Procurement PO')} className="px-6 py-3 border-2 border-blue-600 text-blue-600 rounded-xl font-black text-[10px] uppercase flex items-center gap-2 hover:bg-blue-50"><Download size={16}/> Print PO</button>}
                        <button onClick={() => handleStageUpdate(1, { status: 'completed', actualDate: new Date().toISOString().split('T')[0] })} className="px-10 py-3 bg-emerald-600 text-white rounded-xl font-black text-[10px] uppercase shadow-lg">Mark Done</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </StageCard>

        {/* STAGES 2, 3, 4 */}
        {[
          { id: 2, name: 'Dyeing Stage', icon: <Palette size={20}/>, label: 'Dyeing Technique' },
          { id: 3, name: 'Printing Stage', icon: <Printer size={20}/>, label: 'Print Technique' },
          { id: 4, name: 'Embroidery Stage', icon: <Scissors size={20}/>, label: 'Embroidery Work' },
        ].map(s => (
          <StageCard key={s.id} title={s.name} icon={s.icon} stage={stages[s.id]} expanded={expandedStage === s.id} onToggle={() => !isLocked(s.id) && setExpandedStage(s.id)} locked={isLocked(s.id)}>
              <div className="space-y-6">
                <div className="flex items-end gap-4 p-5 bg-gray-50 rounded-2xl border border-gray-100">
                  <div className="flex-1"><label className="text-[10px] font-black text-gray-400 uppercase block mb-1">Budget Days</label><input type="number" className="w-24 p-3 bg-white border border-gray-200 rounded-xl font-black text-sm" value={stages[s.id].assignedDays} onChange={(e) => handleStageUpdate(s.id, { assignedDays: Number(e.target.value) })}/></div>
                </div>
                {stages[s.id].status === 'pending' ? (
                  <div className="flex gap-4">
                    <button onClick={() => handleStageUpdate(s.id, { status: 'na' })} className="flex-1 py-5 border-2 text-gray-400 border-gray-100 rounded-2xl font-black uppercase text-xs hover:bg-gray-50 transition-all">Not Required</button>
                    <button onClick={() => handleStageUpdate(s.id, { status: 'in_progress' })} className="flex-1 py-5 bg-blue-600 text-white rounded-2xl font-black uppercase text-xs shadow-lg">Create Work Order</button>
                  </div>
                ) : stages[s.id].status === 'na' ? (
                   <div className="p-6 bg-gray-50 rounded-2xl border border-dashed border-gray-200 flex justify-between items-center"><p className="text-xs font-black text-gray-400 uppercase italic">Skipped: Not Required</p><button onClick={() => handleStageUpdate(s.id, {status: 'pending'})} className="text-[10px] font-black text-blue-600 uppercase underline">Undo</button></div>
                ) : (
                  <div className="space-y-4">
                    <div className="divide-y divide-gray-100">
                      {stageConfigs[s.id]?.map((config, idx) => (
                        <div key={idx} className="grid grid-cols-1 md:grid-cols-6 gap-4 py-4 items-end">
                          <div className="text-[10px] font-black text-gray-400 uppercase">STYLE: {config.item_number}</div>
                          <div className="md:col-span-2"><label className="text-[9px] font-black text-gray-400 uppercase mb-1 block">{s.label}</label><input disabled={stages[s.id].poConfirmed} className="w-full p-2 bg-white border border-gray-100 rounded-lg text-xs font-bold disabled:bg-transparent disabled:border-0" value={config.technique} onChange={e => {const c=[...stageConfigs[s.id]]; c[idx].technique=e.target.value; setStageConfigs({...stageConfigs, [s.id]: c})}} /></div>
                          <div className="md:col-span-2"><label className="text-[9px] font-black text-gray-400 uppercase mb-1 block">Assigned Vendor</label><input disabled={stages[s.id].poConfirmed} className="w-full p-2 bg-white border border-gray-100 rounded-lg text-xs font-bold disabled:bg-transparent disabled:border-0" value={config.vendor} onChange={e => {const c=[...stageConfigs[s.id]]; c[idx].vendor=e.target.value; setStageConfigs({...stageConfigs, [s.id]: c})}} /></div>
                          <div className="text-right text-xs font-black">Qty: {config.qty}</div>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between items-center pt-6 border-t">
                      <button onClick={() => handleStageUpdate(s.id, {status: 'pending', poConfirmed: false})} className="text-[10px] font-black text-gray-400 uppercase underline">Reset</button>
                      <div className="flex gap-2">
                        {!stages[s.id].poConfirmed ? (
                          <button onClick={() => handleStageUpdate(s.id, { poConfirmed: true })} className="px-10 py-3 bg-blue-600 text-white rounded-xl font-black text-[10px] uppercase">Confirm Order</button>
                        ) : (
                          <>
                            <button onClick={() => triggerPrint(s.id, s.name)} className="px-6 py-3 border-2 border-blue-600 text-blue-600 rounded-xl font-black text-[10px] uppercase flex items-center gap-2"><Download size={16}/> Work Order PO</button>
                            <button onClick={() => handleStageUpdate(s.id, { status: 'completed', actualDate: new Date().toISOString().split('T')[0] })} className="px-10 py-3 bg-emerald-600 text-white rounded-xl font-black text-[10px] uppercase shadow-lg">Mark Done</button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
          </StageCard>
        ))}

        <StageCard title="Pattern & Sampling" icon={<Scissors size={20}/>} stage={stages[5]} expanded={expandedStage === 5} onToggle={() => !isLocked(5) && setExpandedStage(5)} locked={isLocked(5)} mandatory>
          <div className="space-y-6">
            <div className="flex items-end gap-4 p-5 bg-gray-50 rounded-2xl border border-gray-100">
               <div className="flex-1"><label className="text-[10px] font-black text-gray-400 uppercase block mb-1">Budget Days</label><input type="number" className="w-24 p-3 bg-white border border-gray-200 rounded-xl font-black text-sm" value={stages[5].assignedDays} onChange={(e) => handleStageUpdate(5, { assignedDays: Number(e.target.value) })}/></div>
               <p className="text-xs font-black text-gray-900 uppercase">Target: {order.delivery_date || 'N/A'}</p>
            </div>
            {!stages[5].poConfirmed ? (
               <button onClick={() => handleStageUpdate(5, { poConfirmed: true })} className="w-full py-5 bg-blue-600 text-white rounded-[1.5rem] font-black uppercase text-xs">Start Sampling</button>
            ) : (
              <div className="space-y-4">
                <table className="w-full text-left">
                  <thead className="text-[10px] font-black text-gray-400 uppercase border-b"><tr><th className="pb-3">Style</th><th className="pb-3">Production Notes</th><th className="text-right pb-3">Status</th></tr></thead>
                  <tbody>
                    {samplingStyles.map((style, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-4 text-xs font-bold uppercase">{style.item_number}</td>
                        <td><input className="w-full p-2 bg-white border border-gray-100 rounded-lg text-[10px] font-bold" value={style.notes} onChange={e => {const r=[...samplingStyles]; r[i].notes=e.target.value; setSamplingStyles(r)}} /></td>
                        <td className="text-right"><button onClick={() => {const r = [...samplingStyles]; r[i].isDone = !r[i].isDone; setSamplingStyles(r)}} className={`p-2 rounded-xl transition-all shadow-sm ${style.isDone ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}><Check size={18}/></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button onClick={async () => { handleStageUpdate(5, { status: 'completed', actualDate: new Date().toISOString().split('T')[0] }); alert("ORDER COMPLETED!"); window.location.reload(); }} disabled={samplingStyles.some(s => !s.isDone)} className="w-full py-5 bg-emerald-600 text-white rounded-[1.5rem] font-black uppercase text-xs shadow-xl disabled:opacity-30">Finish Production</button>
              </div>
            )}
          </div>
        </StageCard>
      </div>

      {/* --- CONFIDENTIAL ANONYMOUS VENDOR PO VIEW (STAYS HIDDEN ON SCREEN) --- */}
      <div className="hidden print:block p-12 bg-white min-h-screen w-full relative z-[9999]">
         <div className="text-center border-b-[10px] border-black pb-8 mb-12">
            <h1 className="text-6xl font-black uppercase tracking-tighter">Work Order / PO</h1>
            <p className="text-xl font-bold mt-2 tracking-[0.4em] text-gray-500 uppercase">{activePrintStage?.title || 'Spec Sheet'}</p>
         </div>
         <div className="flex justify-between mb-16">
            <div className="space-y-2"><p className="text-[10px] font-black uppercase text-gray-400 tracking-widest">Order Reference</p><p className="text-4xl font-black uppercase tracking-tighter">#{order.order_id}</p></div>
            <div className="text-right space-y-2"><p className="text-[10px] font-black uppercase text-gray-400 tracking-widest">Document Issued</p><p className="text-xl font-bold">{new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
         </div>
         <div className="mb-16">
            <h3 className="text-sm font-black uppercase border-b-4 border-black pb-2 mb-8 ml-1">Technical Requirements</h3>
            <table className="w-full border-[3px] border-black border-collapse">
               <thead className="bg-gray-100">
                  <tr className="text-[11px] font-black uppercase text-left border-b-[3px] border-black">
                     {activePrintStage?.id === 1 ? (
                        <><th className="p-5 border-r-[3px] border-black">Fabric Material</th><th className="p-5 border-r-[3px] border-black">Required Color</th><th className="p-5 border-r-[3px] border-black text-center">Qty</th><th className="p-5">Assigned Vendor</th></>
                     ) : (
                        <><th className="p-5 border-r-[3px] border-black">Style Ref</th><th className="p-5 border-r-[3px] border-black">Tech Instructions</th><th className="p-5 border-r-[3px] border-black text-center">Qty</th><th className="p-5">Assigned Vendor</th></>
                     )}
                  </tr>
               </thead>
               <tbody className="text-sm">
                  {activePrintStage?.id === 1 ? (
                    fabricRows.map((f, i) => (
                        <tr key={i} className="border-b-[2px] border-black">
                           <td className="p-5 border-r-[3px] border-black uppercase font-black">{f.fabric || '-'}</td>
                           <td className="p-5 border-r-[3px] border-black uppercase font-bold">{f.color || '-'}</td>
                           <td className="p-5 border-r-[3px] border-black text-center font-black text-3xl">{f.qty}</td>
                           <td className="p-5 uppercase font-black text-blue-600">{f.vendor || 'FACTORY STOCK'}</td>
                        </tr>
                    ))
                  ) : (
                    stageConfigs[activePrintStage?.id]?.map((c, i) => (
                        <tr key={i} className="border-b-[2px] border-black">
                           <td className="p-5 border-r-[3px] border-black uppercase font-black">{c.item_number}</td>
                           <td className="p-5 border-r-[3px] border-black uppercase font-bold italic">{c.technique || 'STANDARD PRODUCTION'}</td>
                           <td className="p-5 border-r-[3px] border-black text-center font-black text-2xl">{c.qty}</td>
                           <td className="p-5 uppercase font-black text-blue-600">{c.vendor || 'NOT ASSIGNED'}</td>
                        </tr>
                    ))
                  )}
               </tbody>
            </table>
         </div>
         <div className="mt-40 pt-10 border-t-4 border-dashed border-gray-300 flex justify-between">
            <div className="max-w-md"><p className="text-[10px] font-black uppercase text-red-600 mb-2">Confidentiality Warning</p><p className="text-[10px] font-bold text-gray-400 leading-relaxed uppercase">This document is for internal production purposes only. Do not share client identity information.</p></div>
            <div className="w-64 border-t-4 border-black text-center pt-4"><p className="text-xs font-black uppercase tracking-widest">Authorized Signatory</p></div>
         </div>
      </div>
    </div>
  );
}

function StageCard({ title, icon, stage, expanded, onToggle, locked = false, children }: any) {
  const startStr = stage.startDate;
  const actualStr = stage.actualDate;
  
  // Calculate days spent accurately
  const spent = React.useMemo(() => {
    if (!startStr) return 0;
    const start = new Date(startStr);
    const end = actualStr ? new Date(actualStr) : new Date();
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    return Math.max(0, Math.ceil((end.getTime() - start.getTime()) / (1000 * 3600 * 24)));
  }, [startStr, actualStr]);

  // Culprit logic: Is this specific stage causing the delay?
  const isOverBudget = spent > stage.assignedDays && stage.assignedDays > 0;
  const isDelayedCulprit = (stage.status === 'in_progress' || stage.status === 'completed') && isOverBudget;

  return (
    <div className={`rounded-[2.5rem] border-2 transition-all duration-300 
      ${locked ? 'bg-gray-50 opacity-40 cursor-not-allowed border-transparent' : 
        isDelayedCulprit ? 'border-red-500 bg-red-50 shadow-lg scale-[1.01]' : 
        stage.status === 'completed' ? 'border-emerald-200 bg-white' : 
        stage.status === 'na' ? 'border-gray-100 bg-gray-50/50' : 
        expanded ? 'border-blue-500 shadow-xl bg-white scale-[1.01]' : 
        'border-gray-100 bg-white hover:border-gray-200'}`}>
      
      <div onClick={onToggle} className={`px-8 py-6 flex items-center justify-between ${locked ? '' : 'cursor-pointer group'}`}>
        <div className="flex items-center gap-5">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all 
            ${locked ? 'bg-gray-200 text-gray-400' : 
              isDelayedCulprit ? 'bg-red-600 text-white shadow-lg animate-pulse' : 
              stage.status === 'completed' ? 'bg-emerald-500 text-white shadow-lg' : 
              stage.status === 'na' ? 'bg-gray-400 text-white' : 
              'bg-blue-50 text-blue-600'}`}>
            {locked ? <Lock size={20}/> : 
             isDelayedCulprit ? <AlertCircle size={24}/> :
             stage.status === 'completed' ? <CheckCircle2 size={24}/> : 
             stage.status === 'na' ? <XCircle size={24}/> : icon}
          </div>
          
          <div>
            <h3 className={`text-base font-black uppercase tracking-widest ${stage.status === 'na' ? 'text-gray-400' : 'text-gray-900'}`}>
              {title}
            </h3>
            <div className="flex gap-4 mt-1 items-center">
              <span className={`text-[10px] font-black uppercase ${isDelayedCulprit ? 'text-red-600' : stage.status === 'completed' ? 'text-emerald-500' : 'text-blue-600'}`}>
                {isDelayedCulprit ? 'OVER BUDGET' : stage.status.replace('_', ' ')}
              </span>
              <div className="h-1 w-1 bg-gray-300 rounded-full"></div>
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">
                Allocated: {stage.assignedDays}d • Used: {spent}d
              </span>
              {isDelayedCulprit && (
                <span className="ml-2 text-[9px] font-black text-white bg-red-600 px-2 py-0.5 rounded-lg">
                  CULPRIT: +{spent - stage.assignedDays}d
                </span>
              )}
            </div>
          </div>
        </div>
        {!locked && (expanded ? <ChevronUp size={24} className={isDelayedCulprit ? 'text-red-500' : 'text-blue-500'}/> : <ChevronDown size={24} className="text-gray-300"/>)}
      </div>
      {!locked && expanded && <div className="px-10 pb-10 animate-in fade-in slide-in-from-top-4 duration-300">{children}</div>}
    </div>
  );
}