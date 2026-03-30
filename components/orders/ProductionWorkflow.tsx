'use client';

import React, { useState, useEffect } from 'react';
import { 
  CheckCircle2, Lock, Truck, Palette, Printer, Scissors, 
  ChevronDown, ChevronUp, Download, Timer, AlertCircle, XCircle, Check
} from 'lucide-react';

export default function ProductionWorkflow({ order }: { order: any }) {
  const [activePrintStage, setActivePrintStage] = useState<any>(null);
  const [expandedStage, setExpandedStage] = useState<number | null>(1);
  const [isSaving, setIsSaving] = useState(false);

  // Load from DB or default
  const [stages, setStages] = useState<Record<number, any>>(
    order.production_workflow || {
      1: { status: 'pending', assignedDays: 0, startDate: order?.created_at },
      2: { status: 'pending', assignedDays: 0 },
      3: { status: 'pending', assignedDays: 0 },
      4: { status: 'pending', assignedDays: 0 },
      5: { status: 'pending', assignedDays: 0 },
    }
  );

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

  const totalBudgetDays = React.useMemo(() => {
    if (!order.delivery_date || !order.created_at) return 0;
    const start = new Date(order.created_at);
    const end = new Date(order.delivery_date);
    start.setHours(0,0,0,0); end.setHours(0,0,0,0);
    return Math.max(0, Math.ceil((end.getTime() - start.getTime()) / (1000 * 3600 * 24)));
  }, [order.delivery_date, order.created_at]);

  const saveWorkflow = async (updatedStages: any) => {
    setIsSaving(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ production_workflow: updatedStages }),
      });
      
      if (res.ok) {
        // Optional: you can call a refresh function here if you passed one
        console.log("Saved successfully");
      }
    } catch (err) {
      console.error("Save failed", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleStageUpdate = (id: number, updates: Partial<any>) => {
    const newStages = { ...stages, [id]: { ...stages[id], ...updates } };
    
    // Waterfall logic: Unlock next stage
    if (updates.status === 'completed' || updates.status === 'na') {
      const nextId = id + 1;
      if (nextId <= 5 && !newStages[nextId].startDate) {
        newStages[nextId] = { ...newStages[nextId], startDate: new Date().toISOString() };
        setExpandedStage(nextId);
      }
    }
    setStages(newStages);
    saveWorkflow(newStages);
  };

  const triggerPrint = (stageId: number, title: string) => {
    setActivePrintStage({ id: stageId, title });
    setTimeout(() => { window.print(); }, 100);
  };

  const isLocked = (id: number) => {
    if (id === 1) return false;
    const prev = stages[id - 1];
    return prev.status !== 'completed' && prev.status !== 'na';
  };

  const assignedTotal = Object.values(stages).reduce((a, b) => a + (Number(b.assignedDays) || 0), 0);

  return (
    <div className="space-y-6 pb-20 no-scrollbar relative">
      {isSaving && <div className="fixed top-24 right-10 bg-blue-600 text-white px-4 py-2 rounded-full text-[10px] font-black uppercase animate-pulse shadow-lg z-50">Saving...</div>}

      {/* BUDGET HEADER */}
      <div className="bg-white rounded-[2.5rem] border-2 border-gray-100 p-8 shadow-sm no-print">
        <div className="flex flex-col md:flex-row justify-between items-center gap-10">
          <div className="flex items-center gap-5">
             <div className="w-14 h-14 bg-blue-600 rounded-3xl flex items-center justify-center text-white shadow-xl shadow-blue-600/20"><Timer size={28} /></div>
             <div><p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em]">Project Capacity</p><h2 className="text-2xl font-black text-gray-900">{totalBudgetDays} Days</h2></div>
          </div>
          <div className="flex gap-12">
             <div className="text-center"><p className="text-[10px] font-black text-gray-400 uppercase">Assigned</p><p className="text-xl font-black text-gray-900">{assignedTotal}d</p></div>
             <div className="text-center"><p className="text-[10px] font-black text-gray-400 uppercase">Buffer</p><p className={`text-xl font-black ${totalBudgetDays - assignedTotal < 0 ? 'text-red-500' : 'text-emerald-500'}`}>{totalBudgetDays - assignedTotal}d</p></div>
          </div>
        </div>
      </div>

      <div className="space-y-4 no-print">
        {/* STAGE 1 */}
        <StageCard title="Fabric Procurement" icon={<Truck size={20}/>} stage={stages[1]} expanded={expandedStage === 1} onToggle={() => setExpandedStage(1)}>
          <div className="space-y-6">
            {!stages[1].mode ? (
              <div className="flex gap-4">
                <button onClick={() => handleStageUpdate(1, { mode: 'stock', status: 'in_progress' })} className="flex-1 py-5 bg-emerald-600 text-white rounded-2xl font-black uppercase text-xs">Existing Stock</button>
                <button onClick={() => handleStageUpdate(1, { mode: 'vendor', status: 'in_progress' })} className="flex-1 py-5 bg-blue-600 text-white rounded-2xl font-black uppercase text-xs">Order From Vendor</button>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex-1"><label className="text-[10px] font-black text-gray-400 uppercase block mb-1">Budget Days</label><input type="number" className="w-24 p-3 bg-gray-50 border border-gray-200 rounded-xl font-black text-sm" value={stages[1].assignedDays} onChange={(e) => handleStageUpdate(1, { assignedDays: Number(e.target.value) })}/></div>
                <table className="w-full text-left text-xs">
                  <thead className="font-black text-gray-400 uppercase"><tr><th className="pb-2">Fabric</th><th className="pb-2">Color</th><th className="pb-2">Qty</th>{stages[1].mode === 'vendor' && <th className="pb-2">Vendor</th>}</tr></thead>
                  <tbody>
                    {fabricRows.map((f, i) => (
                      <tr key={i} className="border-t border-gray-50"><td className="py-3 font-bold">{f.fabric}</td><td className="font-bold">{f.color}</td><td className="font-bold">{f.qty}</td>{stages[1].mode === 'vendor' && <td><input className="p-1 border rounded w-full" value={f.vendor} onChange={e => {const r=[...fabricRows]; r[i].vendor=e.target.value; setFabricRows(r)}} /></td>}</tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex justify-between border-t pt-4">
                    <button onClick={() => handleStageUpdate(1, { mode: null, status: 'pending' })} className="text-[10px] uppercase font-bold text-gray-400 underline">Reset</button>
                    <button onClick={() => handleStageUpdate(1, { status: 'completed', actualDate: new Date().toISOString() })} className="px-8 py-3 bg-emerald-600 text-white rounded-xl font-black uppercase text-[10px]">Complete Stage</button>
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
                <input type="number" className="w-24 p-3 bg-gray-50 border border-gray-200 rounded-xl font-black text-sm" value={stages[s.id].assignedDays} onChange={(e) => handleStageUpdate(s.id, { assignedDays: Number(e.target.value) })}/>
                {stages[s.id].status === 'pending' ? (
                  <div className="flex gap-4">
                    <button onClick={() => handleStageUpdate(s.id, { status: 'na' })} className="flex-1 py-5 border-2 text-gray-400 border-gray-100 rounded-2xl font-black uppercase text-xs">Not Required</button>
                    <button onClick={() => handleStageUpdate(s.id, { status: 'in_progress' })} className="flex-1 py-5 bg-blue-600 text-white rounded-2xl font-black uppercase text-xs shadow-lg">Start Stage</button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {stageConfigs[s.id]?.map((config, idx) => (
                      <div key={idx} className="grid grid-cols-3 gap-4 text-[10px] items-end border-b pb-2">
                        <div className="font-bold">STYLE: {config.item_number}</div>
                        <div><label className="text-gray-400 uppercase mb-1 block">{s.label}</label><input className="w-full p-2 bg-gray-50 rounded border" value={config.technique} onChange={e => {const c=[...stageConfigs[s.id]]; c[idx].technique=e.target.value; setStageConfigs({...stageConfigs, [s.id]: c})}} /></div>
                        <div><label className="text-gray-400 uppercase mb-1 block">Vendor</label><input className="w-full p-2 bg-gray-50 rounded border" value={config.vendor} onChange={e => {const c=[...stageConfigs[s.id]]; c[idx].vendor=e.target.value; setStageConfigs({...stageConfigs, [s.id]: c})}} /></div>
                      </div>
                    ))}
                    <div className="flex justify-between pt-4">
                        <button onClick={() => triggerPrint(s.id, s.name)} className="px-4 py-2 border border-blue-600 text-blue-600 rounded-lg font-black text-[10px] uppercase">Print Work Order</button>
                        <button onClick={() => handleStageUpdate(s.id, { status: 'completed', actualDate: new Date().toISOString() })} className="px-8 py-3 bg-emerald-600 text-white rounded-xl font-black uppercase text-[10px]">Complete</button>
                    </div>
                  </div>
                )}
              </div>
          </StageCard>
        ))}

        {/* STAGE 5 */}
        <StageCard title="Pattern & Sampling" icon={<Scissors size={20}/>} stage={stages[5]} expanded={expandedStage === 5} onToggle={() => !isLocked(5) && setExpandedStage(5)} locked={isLocked(5)}>
          <div className="space-y-6">
            <input type="number" className="w-24 p-3 bg-gray-50 border border-gray-200 rounded-xl font-black text-sm" value={stages[5].assignedDays} onChange={(e) => handleStageUpdate(5, { assignedDays: Number(e.target.value) })}/>
            <table className="w-full text-left text-xs">
                <thead><tr className="text-gray-400 uppercase font-black"><th>Style</th><th>Notes</th><th className="text-right">Done</th></tr></thead>
                <tbody>
                {samplingStyles.map((style, i) => (
                    <tr key={i} className="border-t">
                    <td className="py-4 font-bold">{style.item_number}</td>
                    <td><input className="w-full p-2 bg-gray-50 rounded border" value={style.notes} onChange={e => {const r=[...samplingStyles]; r[i].notes=e.target.value; setSamplingStyles(r)}} /></td>
                    <td className="text-right"><button onClick={() => {const r = [...samplingStyles]; r[i].isDone = !r[i].isDone; setSamplingStyles(r)}} className={`p-2 rounded-lg ${style.isDone ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-400'}`}><Check size={16}/></button></td>
                    </tr>
                ))}
                </tbody>
            </table>
            <button onClick={() => handleStageUpdate(5, { status: 'completed', actualDate: new Date().toISOString() })} className="w-full py-4 bg-emerald-600 text-white rounded-xl font-black uppercase text-xs shadow-xl">Finish Order</button>
          </div>
        </StageCard>
      </div>

      {/* PRINT VIEW (PRESERVED) */}
      <div className="hidden print:block p-10 bg-white">
          <h1 className="text-2xl font-black uppercase border-b-4 border-black mb-4">{activePrintStage?.title}</h1>
          <p className="font-bold">ORDER: #{order.order_id}</p>
          {/* ... PDF Logic remains here ... */}
      </div>
    </div>
  );
}

function StageCard({ title, icon, stage, expanded, onToggle, locked = false, children }: any) {
  const start = stage.startDate ? new Date(stage.startDate) : null;
  const end = stage.actualDate ? new Date(stage.actualDate) : new Date();
  const spent = start ? Math.max(0, Math.ceil((end.getTime() - start.getTime()) / (1000 * 3600 * 24))) : 0;
  const isDelayed = spent > stage.assignedDays && stage.assignedDays > 0;

  return (
    <div className={`rounded-[2.5rem] border-2 transition-all duration-300 ${locked ? 'bg-gray-50 opacity-40 cursor-not-allowed border-transparent' : isDelayed ? 'border-red-200 bg-red-50' : stage.status === 'completed' ? 'border-emerald-200 bg-white' : expanded ? 'border-blue-500 shadow-xl bg-white scale-[1.01]' : 'border-gray-100 bg-white'}`}>
      <div onClick={onToggle} className={`px-8 py-6 flex items-center justify-between ${locked ? '' : 'cursor-pointer group'}`}>
        <div className="flex items-center gap-5">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${locked ? 'bg-gray-200 text-gray-400' : isDelayed ? 'bg-red-500 text-white animate-pulse' : stage.status === 'completed' ? 'bg-emerald-500 text-white shadow-lg' : 'bg-blue-50 text-blue-600'}`}>{locked ? <Lock size={20}/> : isDelayed ? <AlertCircle size={24}/> : stage.status === 'completed' ? <CheckCircle2 size={24}/> : icon}</div>
          <div><h3 className={`text-base font-black uppercase tracking-widest ${locked ? 'text-gray-300' : 'text-gray-900'}`}>{title}</h3>
            <div className="flex gap-4 mt-1 items-center"><span className={`text-[10px] font-black uppercase ${isDelayed ? 'text-red-600' : stage.status === 'completed' ? 'text-emerald-500' : 'text-blue-600'}`}>{stage.status}</span><div className="h-1 w-1 bg-gray-300 rounded-full"></div><span className="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">Allocated: {stage.assignedDays}d • Used: {spent}d</span></div>
          </div>
        </div>
        {!locked && (expanded ? <ChevronUp size={24} className="text-blue-500"/> : <ChevronDown size={24} className="text-gray-300"/>)}
      </div>
      {!locked && expanded && <div className="px-10 pb-10 animate-in fade-in slide-in-from-top-4 duration-300">{children}</div>}
    </div>
  );
}