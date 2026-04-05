'use client';

import React, { useState, useEffect } from 'react';
import { Plus, Copy, Trash2, Upload, X, FileText, ChevronDown } from 'lucide-react';
import Modal from '../ui/Modal';

interface StyleEntry {
  id: string;
  style_name: string;
  item_number: string;
  fabric: string;
  color_name: string;
  quantity: number;
  notes: string;
  files: File[];
  print_type: string; 
}

export default function OrderModal({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [clients, setClients] = useState<any[]>([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [deliveryDate, setDeliveryDate] = useState(''); // New state

  const [newClientName, setNewClientName] = useState('');
  const [newClientEmail, setNewClientEmail] = useState('');
  
  const [styles, setStyles] = useState<StyleEntry[]>([{
    id: Math.random().toString(36).substr(2, 9),
    style_name: '',
    item_number: '',
    fabric: '',
    color_name: '',
    quantity: 1,
    notes: '',
    files: [],
    print_type: '' 
  }]);

  useEffect(() => {
    if (isOpen) {
      fetch('/api/clients').then(res => res.json()).then(data => setClients(data.data || []));
    }
  }, [isOpen]);

  const addStyle = () => {
    setStyles([...styles, {
      id: Math.random().toString(36).substr(2, 9),
      style_name: '',
      item_number: '',
      fabric: '',
      color_name: '',
      quantity: 1,
      notes: '',
      files: [],
      print_type: ''
    }]);
  };

  const copyStyle = (index: number) => {
    const original = styles[index];
    const duplicate = { ...original, id: Math.random().toString(36).substr(2, 9), files: [] };
    const newStyles = [...styles];
    newStyles.splice(index + 1, 0, duplicate);
    setStyles(newStyles);
  };

  const removeStyle = (index: number) => {
    if (styles.length === 1) return;
    setStyles(styles.filter((_, i) => i !== index));
  };

  const updateStyle = (index: number, field: keyof StyleEntry, value: any) => {
    const newStyles = [...styles];
    newStyles[index] = { ...newStyles[index], [field]: value };
    setStyles(newStyles);
  };

  const handleFileChange = (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const currentFiles = styles[index].files;
      const newFiles = Array.from(e.target.files);
      if (currentFiles.length + newFiles.length > 2) {
        alert("Max 2 files allowed per style.");
        return;
      }
      updateStyle(index, 'files', [...currentFiles, ...newFiles]);
    }
  };

  const removeFile = (styleIndex: number, fileIndex: number) => {
    const currentFiles = styles[styleIndex].files;
    updateStyle(styleIndex, 'files', currentFiles.filter((_, i) => i !== fileIndex));
  };

  // HELPER: Convert "Solid Dyed" back to "solid_dyed" for the database
  const mapTypeToSlug = (type: string) => {
    const lower = type.toLowerCase().trim();
    if (lower === 'solid dyed') return 'solid_dyed';
    if (lower === 'printed') return 'printed';
    return lower.replace(/\s+/g, '_') || 'solid_dyed';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClientId && (!newClientName.trim() || !newClientEmail.trim())) {
      alert("Please select an existing client or enter a name and email for a new client.");
      return;
    }
    setLoading(true);

    try {
      const payload = {
        client_id: selectedClientId ? parseInt(selectedClientId) : null,
        new_client_name: !selectedClientId ? newClientName.trim() : null,
        new_client_email: !selectedClientId ? newClientEmail.trim() : null,
        delivery_date: deliveryDate || null, // Include delivery date here
        styles: styles.map(s => ({
          style_name: s.style_name.trim(),
          item_number: s.item_number.trim(),
          quantity: s.quantity || 1,
          fabric: s.fabric || '',
          color_name: s.color_name || '',
          notes: s.notes || '',
          print_type: mapTypeToSlug(s.print_type) // Convert to technical slug
        }))
      };

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const responseData = await res.json();

      if (res.ok && responseData.success) {
        alert('Order Created Successfully!');
        onClose();
        window.location.reload();
      } else {
        // Show specific error from server if available
        alert(`Error: ${responseData.error || responseData.message || 'Submission failed'}`);
      }
    } catch (error) {
      console.error("Submission Error:", error);
      alert('Network error. Check your server logs.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create New Sample Order" size="xl">
      <form onSubmit={handleSubmit} className="space-y-8 p-4 max-h-[85vh] overflow-y-auto no-scrollbar">
        
        {/* CLIENT & DATE SELECTION */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
  <div className="space-y-3">
    <label className="text-[11px] font-black text-gray-900 uppercase tracking-[0.15em] ml-1">Select Client *</label>
    <div className="relative">
      <select 
        className="w-full h-14 px-5 bg-white border-2 border-gray-100 rounded-2xl appearance-none focus:border-blue-600 outline-none transition-all font-bold text-gray-700"
        value={selectedClientId}
        onChange={e => setSelectedClientId(e.target.value)}
      >
        <option value="">— Create New Client —</option>
        {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <ChevronDown className="absolute right-5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={18} />
    </div>
    {!selectedClientId && (
      <div className="space-y-2 pt-1">
        <input
          className="w-full h-12 px-4 bg-gray-50 border-2 border-dashed border-gray-200 rounded-xl focus:border-blue-600 outline-none font-bold text-sm"
          placeholder="New client name *"
          value={newClientName}
          onChange={e => setNewClientName(e.target.value)}
        />
        <input
          className="w-full h-12 px-4 bg-gray-50 border-2 border-dashed border-gray-200 rounded-xl focus:border-blue-600 outline-none font-bold text-sm"
          placeholder="New client email *"
          type="email"
          value={newClientEmail}
          onChange={e => setNewClientEmail(e.target.value)}
        />
      </div>
    )}
  </div>

          <div className="space-y-3">
            <label className="text-[11px] font-black text-gray-900 uppercase tracking-[0.15em] ml-1">Target Delivery Date</label>
            <input 
              type="date"
              className="w-full h-14 px-5 bg-white border-2 border-gray-100 rounded-2xl focus:border-blue-600 outline-none transition-all font-bold text-gray-700"
              value={deliveryDate}
              onChange={e => setDeliveryDate(e.target.value)}
            />
          </div>
        </div>

        {/* STYLES LIST */}
        <div className="space-y-6">
          <div className="flex justify-between items-center px-1">
            <h3 className="text-sm font-black text-gray-900 uppercase tracking-widest">Order Styles ({styles.length})</h3>
            <button type="button" onClick={addStyle} className="flex items-center gap-2 px-5 py-2.5 bg-blue-50 text-blue-600 rounded-xl text-[11px] font-black uppercase hover:bg-blue-100">
              <Plus size={16} /> Add Another Style
            </button>
          </div>

          <div className="space-y-8">
            {styles.map((style, idx) => (
              <div key={style.id} className="relative bg-white rounded-[2rem] p-8 border-2 border-gray-100 shadow-sm hover:border-blue-100 transition-all duration-300">
                
                <div className="flex justify-between items-center mb-8 pb-4 border-b border-gray-50">
                  <span className="text-xs font-black text-blue-600 uppercase tracking-widest">Style #{idx + 1}</span>
                  <div className="flex gap-2">
                    <button 
                      type="button" 
                      onClick={() => copyStyle(idx)}
                      className="flex items-center gap-1.5 px-3 py-2 bg-gray-50 text-gray-500 rounded-lg text-[10px] font-black uppercase hover:bg-blue-50 hover:text-blue-600 transition-all"
                    >
                      <Copy size={14} /> Duplicate Style
                    </button>
                    {styles.length > 1 && (
                      <button type="button" onClick={() => removeStyle(idx)} className="p-2 text-gray-300 hover:text-red-500 transition-colors">
                        <Trash2 size={18} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-gray-900 uppercase tracking-widest">Style Name *</label>
                    <input className="w-full h-12 px-4 bg-gray-50/50 border border-gray-200 rounded-xl focus:bg-white focus:border-blue-600 outline-none font-bold"
                      value={style.style_name} onChange={e => updateStyle(idx, 'style_name', e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-gray-900 uppercase tracking-widest">Item Number *</label>
                    <input className="w-full h-12 px-4 bg-gray-50/50 border border-gray-200 rounded-xl focus:bg-white focus:border-blue-600 outline-none font-bold"
                      value={style.item_number} onChange={e => updateStyle(idx, 'item_number', e.target.value)} required />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-gray-900 uppercase tracking-widest">Type (Optional)</label>
                    <input className="w-full h-12 px-4 bg-gray-50/50 border border-gray-200 rounded-xl focus:bg-white focus:border-blue-600 outline-none font-bold"
                      value={style.print_type} onChange={e => updateStyle(idx, 'print_type', e.target.value)} placeholder="e.g. Solid Dyed, Printed..." />
                    <div className="flex gap-2 mt-2">
                        {['Solid Dyed', 'Printed'].map(t => (
                          <button key={t} type="button" onClick={() => updateStyle(idx, 'print_type', t)}
                            className="text-[9px] font-black uppercase px-2 py-1 bg-gray-100 text-gray-500 rounded hover:bg-blue-600 hover:text-white transition-colors">
                            + {t}
                          </button>
                        ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Fabric (Optional)</label>
                    <input className="w-full h-12 px-4 bg-gray-50/50 border border-gray-200 rounded-xl focus:bg-white focus:border-blue-600 outline-none font-bold"
                      value={style.fabric} onChange={e => updateStyle(idx, 'fabric', e.target.value)} />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Color (Opt)</label>
                      <input className="w-full h-12 px-4 bg-gray-50/50 border border-gray-200 rounded-xl focus:bg-white focus:border-blue-600 outline-none font-bold"
                        value={style.color_name} onChange={e => updateStyle(idx, 'color_name', e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-gray-900 uppercase tracking-widest">Qty</label>
                      <input type="number" className="w-full h-12 px-4 bg-gray-50/50 border border-gray-200 rounded-xl focus:bg-white focus:border-blue-600 outline-none font-bold"
                        value={style.quantity} onChange={e => updateStyle(idx, 'quantity', parseInt(e.target.value))} min="1" />
                    </div>
                  </div>
                  <div className="md:col-span-2 space-y-2">
                    <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Notes (Optional)</label>
                    <textarea className="w-full h-24 p-4 bg-gray-50/50 border border-gray-200 rounded-xl focus:bg-white focus:border-blue-600 outline-none font-bold resize-none"
                      value={style.notes} onChange={e => updateStyle(idx, 'notes', e.target.value)} />
                  </div>
                </div>

                <div className="mt-8 pt-8 border-t border-gray-50 flex justify-between items-center">
                  <div>
                    <p className="text-[10px] font-black text-gray-900 uppercase tracking-widest mb-1">Design Files (Opt)</p>
                    <p className="text-[9px] text-gray-400 font-bold uppercase tracking-tight">Max 2 per style</p>
                  </div>
                  <div className="flex gap-2">
                    {style.files.map((file, fIdx) => (
                      <div key={fIdx} className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg max-w-[150px]">
                        <FileText size={12} className="text-blue-500" />
                        <span className="text-[9px] font-black text-blue-600 truncate">{file.name}</span>
                        <button type="button" onClick={() => removeFile(idx, fIdx)} className="text-blue-300 hover:text-red-500"><X size={12} /></button>
                      </div>
                    ))}
                    {style.files.length < 2 && (
                      <>
                        <input type="file" className="hidden" id={`file-${style.id}`} onChange={(e) => handleFileChange(idx, e)} />
                        <label htmlFor={`file-${style.id}`} className="cursor-pointer flex items-center gap-2 px-4 py-2 border-2 border-dashed border-gray-200 rounded-xl hover:border-blue-600 transition-all">
                          <Upload size={14} className="text-gray-400" />
                          <span className="text-[10px] font-black text-gray-400 uppercase">Upload</span>
                        </label>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <button type="submit" disabled={loading} className="w-full h-16 bg-blue-600 hover:bg-blue-700 text-white font-black text-sm rounded-[1.5rem] transition-all shadow-xl shadow-blue-600/20 uppercase tracking-[0.2em] disabled:opacity-50">
          {loading ? 'CREATING ORDER...' : 'Confirm & Create Order'}
        </button>
      </form>
    </Modal>
  );
}