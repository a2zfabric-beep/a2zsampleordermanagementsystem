'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { 
  ArrowLeft, Edit, Download, FileText, Calendar, 
  Clock, User, Upload, Eye, Trash2, X, CheckCircle, Plus 
} from 'lucide-react';
import Modal from '@/components/ui/Modal';
import ProductionWorkflow from '@/components/orders/ProductionWorkflow';

interface OrderStyle {
  id: number;
  item_number: string;
  style_name: string;
  print_type: 'solid_dyed' | 'printed';
  color_name: string | null;
  pantone_number: string | null;
  design_name: string | null;
  fabric: string | null;
  quantity: number;
  notes: string | null;
}

interface Client {
  id: number;
  name: string;
  email: string;
  company_name?: string;
}

interface OrderFile {
  id: number;
  file_name: string;
  file_url: string;
  file_type: string;
  file_size: number;
  uploaded_at: string;
}

interface Order {
  id: number;
  order_id: string;
  client_id: number;
  client: Client;
  status: 'draft' | 'submitted' | 'in_review' | 'sampling_in_progress' | 'ready' | 'dispatched';
  created_by: 'client' | 'admin' | 'automation';
  order_source: 'quick' | 'structured' | 'email';
  delivery_date: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  sample_type: string | null;
  notes: string | null;
  batch_id: string | null;
  is_order_created: boolean;
  assigned_to: number | null;
  created_at: string;
  updated_at: string;
  styles: OrderStyle[];
  files: OrderFile[];
  production_workflow: any; // ADD THIS LINE
  courier_name?: string | null;
  tracking_number?: string | null;
  dispatched_at?: string | null;
}

export default function OrderDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const orderId = params?.id as string;

  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState('');
  const [activeTab, setActiveTab] = useState<'details' | 'production'>('details');
  const [courierName, setCourierName] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [dispatchedAt, setDispatchedAt] = useState(new Date().toISOString().split('T')[0]);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [showAddStyleModal, setShowAddStyleModal] = useState(false);
  const [addingStyle, setAddingStyle] = useState(false);

  const [newStyle, setNewStyle] = useState({
    item_number: '',
    style_name: '',
    print_type: 'solid_dyed' as 'solid_dyed' | 'printed',
    color_name: '',
    pantone_number: '',
    design_name: '',
    fabric: '',
    quantity: 1,
    notes: '',
  });

  useEffect(() => {
    if (orderId) fetchOrder();
  }, [orderId]);

  const fetchOrder = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/orders/${orderId}`);
      const data = await response.json();
      if (data.success) {
        setOrder(data.data);
        setStatus(data.data.status);
        setNotes(data.data.notes || '');
        setCourierName(data.data.courier_name || '');
        setTrackingNumber(data.data.tracking_number || '');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStatus = async () => {
    if (!order) return;

    // --- DISPATCH VALIDATION ---
    if (status === 'dispatched') {
      if (!courierName.trim() || !trackingNumber.trim() || !dispatchedAt) {
        alert("❌ DATA REQUIRED: Please enter Courier Name, Tracking Number, and Date before saving.");
        return;
      }
    }

    try {
      setUpdating(true);
      const payload: any = { status, notes };
      
      if (status === 'dispatched') {
        payload.courier_name = courierName;
        payload.tracking_number = trackingNumber;
        // Ensure date is stored in ISO format
        payload.dispatched_at = new Date(dispatchedAt).toISOString();
      }

      const response = await fetch(`/api/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        fetchOrder();
        alert('✅ Order status and dispatch details updated!');
      } else {
        const errorData = await response.json();
        alert(`❌ Error: ${errorData.error || 'Update failed'}`);
      }
    } catch (err: any) {
      alert("Network Error: " + err.message);
    } finally {
      setUpdating(false);
    }
  };

  const handleUploadFiles = async () => {
    if (selectedFiles.length === 0) return;
    try {
      setIsUploading(true);
      const formData = new FormData();
      selectedFiles.forEach((f, i) => formData.append(`file_${i}`, f));
      await fetch(`/api/orders/${orderId}`, { method: 'POST', body: formData });
      alert('Files uploaded!');
      setShowUploadModal(false);
      fetchOrder();
    } finally {
      setIsUploading(false);
    }
  };

  const handleSaveNewStyle = async () => {
    try {
      setAddingStyle(true);
      await fetch(`/api/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ add_style: newStyle }),
      });
      setShowAddStyleModal(false);
      fetchOrder();
    } finally {
      setAddingStyle(false);
    }
  };

  const handleDeleteOrder = async () => {
    if (!confirm("Are you sure you want to PERMANENTLY delete this order? This action cannot be undone.")) return;
    
    try {
      setUpdating(true);
      // Ensure we are hitting the correct endpoint with the ID
      const response = await fetch(`/api/orders?id=${order?.id}`, { 
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      
      const responseText = await response.text();
      let responseData;
      
      try {
        responseData = JSON.parse(responseText);
      } catch (e) {
        responseData = { error: responseText || "No response body from server" };
      }

      if (response.ok && (responseData.success || response.status === 200)) {
        alert("Order deleted successfully");
        router.push('/orders');
      } else {
        // This will now show the REAL error from Supabase/API
        console.error("Delete failed:", responseData);
        alert(`Delete Failed (${response.status}): ${responseData.error || responseData.message || responseText}`);
      }
      
    } catch (err: any) {
      alert("Network Error: " + err.message);
    } finally {
      setUpdating(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  };

  if (loading) return <div className="p-20 text-center animate-pulse">Loading Order Details...</div>;
  if (error || !order) return <div className="p-20 text-red-500">Error: {error || 'Not Found'}</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* --- INTERNAL ORDER SUMMARY (Visible only on Export PDF) --- */}
      <div className="hidden print:block w-full print-internal-summary bg-white p-10">
        <div className="border-b-8 border-blue-600 pb-6 mb-8 flex justify-between items-end">
          <div>
            <h1 className="text-5xl font-black text-blue-600 uppercase tracking-tighter">Order Specification</h1>
            <p className="text-sm font-bold text-gray-500 mt-2">REF: {order.order_id} | DATE: {formatDate(order.created_at)}</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-black uppercase text-gray-400">Client</p>
            <p className="text-xl font-black text-gray-900 uppercase">{order.client?.name}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6 mb-10">
          <div className="border-2 border-gray-100 p-4 rounded-2xl">
            <p className="text-[9px] font-black text-blue-600 uppercase mb-1">Priority</p>
            <p className="text-sm font-black uppercase">{order.priority}</p>
          </div>
          <div className="border-2 border-gray-100 p-4 rounded-2xl">
            <p className="text-[9px] font-black text-blue-600 uppercase mb-1">Target Delivery</p>
            <p className="text-sm font-black">{order.delivery_date ? formatDate(order.delivery_date) : 'FLEXIBLE'}</p>
          </div>
        </div>

        {/* PDF STYLE TABLE */}
        <div className="mb-10">
          <h2 className="text-xs font-black uppercase mb-4 tracking-widest border-b pb-2">Styles & Requirements</h2>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-200 text-[10px] font-black uppercase bg-gray-50">
                <th className="py-2 px-2">Item #</th>
                <th className="py-2 px-2">Style Name</th>
                <th className="py-2 px-2">Fabric</th>
                <th className="py-2 px-2">Color</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2 text-center">Qty</th>
              </tr>
            </thead>
            <tbody>
              {order.styles.map((s) => (
                <tr key={s.id} className="border-b border-gray-100 text-xs">
                  <td className="py-3 px-2 font-bold">{s.item_number}</td>
                  <td className="py-3 px-2">{s.style_name}</td>
                  <td className="py-3 px-2">{s.fabric || '-'}</td>
                  <td className="py-3 px-2">{s.color_name || '-'}</td>
                  <td className="py-3 px-2 capitalize">{s.print_type?.replace('_', ' ')}</td>
                  <td className="py-3 px-2 text-center font-bold">{s.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {order.notes && (
          <div className="p-4 bg-gray-50 rounded-xl mb-10">
            <p className="text-[9px] font-black uppercase text-gray-400 mb-1">General Order Notes</p>
            <p className="text-xs">{order.notes}</p>
          </div>
        )}
      </div>

      {/* --- HEADER NAV --- */}
      <nav className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-10 no-print">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center h-16">
          <Link href="/" className="text-xl font-bold text-gray-900">Order Management</Link>
          <div className="flex space-x-6 text-sm font-medium">
            <Link href="/dashboard" className="text-gray-500 hover:text-blue-600">Dashboard</Link>
            <Link href="/orders" className="text-blue-600">Orders</Link>
          </div>
        </div>
      </nav>

      {/* --- MAIN CONTENT --- */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex justify-between items-end no-print">
          <div>
            <Link href="/orders" className="flex items-center text-xs text-gray-500 mb-2 hover:text-blue-600 transition-colors">
              <ArrowLeft size={14} className="mr-1" /> Back to Orders
            </Link>
            <h1 className="text-2xl font-bold text-gray-900">Order {order.order_id}</h1>
          </div>
          <button onClick={() => window.print()} className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold shadow-lg">
            <Download size={16} className="mr-2" /> Export PDF
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm no-print">
              <h2 className="text-sm font-bold text-gray-900 mb-4 border-b pb-2">Order Information</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-y-6 gap-x-4">
                <div><p className="text-[10px] uppercase tracking-wider text-gray-400 font-bold mb-1">Client Name</p><p className="text-sm font-semibold text-gray-900">{order.client?.name}</p></div>
                <div><p className="text-[10px] uppercase tracking-wider text-gray-400 font-bold mb-1">Priority</p><span className="text-xs font-bold px-2 py-0.5 bg-orange-50 text-orange-600 rounded uppercase">{order.priority}</span></div>
                <div><p className="text-[10px] uppercase tracking-wider text-gray-400 font-bold mb-1">Delivery Date</p><p className="text-sm font-semibold">{order.delivery_date ? formatDate(order.delivery_date) : 'Flexible'}</p></div>
              </div>
            </div>

            <div className="flex border-b-2 border-gray-100 gap-8 mb-6 no-print">
              <button onClick={() => setActiveTab('details')} className={`pb-4 text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'details' ? 'border-b-4 border-blue-600 text-blue-600' : 'text-gray-400'}`}>Specifications</button>
              {order.status !== 'draft' && (
                <button onClick={() => setActiveTab('production')} className={`pb-4 text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'production' ? 'border-b-4 border-blue-600 text-blue-600' : 'text-gray-400'}`}>Workflow Tracker</button>
              )}
            </div>

            {activeTab === 'details' ? (
              <div className="space-y-6">
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-100"><h2 className="text-sm font-bold text-gray-900 uppercase tracking-widest">Style Details ({order.styles.length})</h2></div>
                  <div className="overflow-x-auto p-4">
                    <table className="min-w-full text-left text-sm">
                      <thead className="bg-gray-50 border-b-2 border-gray-200">
                        <tr className="text-gray-900 text-[10px] uppercase font-black tracking-widest">
                          <th className="py-4 px-4">ITEM #</th>
                          <th className="py-4 px-2">STYLE NAME</th>
                          <th className="py-4 px-2">TYPE</th>
                          <th className="py-4 px-2">FABRIC</th>
                          <th className="py-4 px-2">COLOR</th>
                          <th className="py-4 px-2">QTY</th>
                          <th className="py-4 px-2">NOTES</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {order.styles.map((s) => (
                          <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                            <td className="py-3 px-4 font-bold text-blue-600">{s.item_number}</td>
                            <td className="py-3 px-2 text-gray-900 font-semibold">{s.style_name}</td>
                            <td className="py-3 px-2 capitalize text-gray-500">{s.print_type?.replace('_', ' ') || '-'}</td>
                            <td className="py-3 px-2 text-gray-700 font-medium">{s.fabric || '-'}</td>
                            <td className="py-3 px-2 text-gray-700 font-medium">{s.color_name || '-'}</td>
                            <td className="py-3 px-2 font-black text-center">{s.quantity}</td>
                            <td className="py-3 px-2 text-[10px] text-gray-500">{s.notes || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="bg-white rounded-xl border border-gray-200 shadow-sm no-print">
                  <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center">
                    <h2 className="text-sm font-bold text-gray-900 flex items-center"><FileText size={16} className="mr-2 text-blue-600" /> Design Files</h2>
                    <span className="text-[10px] font-black px-3 py-1 bg-blue-600 text-white rounded-full uppercase">{order.files?.length || 0} ATTACHMENTS</span>
                  </div>
                  <div className="p-6">
                    {order.files?.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {order.files.map((file) => (
                          <div key={file.id} className="group flex items-center p-3 border border-gray-100 rounded-xl hover:border-blue-200 hover:bg-blue-50/20 transition-all">
                            <div className="h-10 w-10 bg-white border border-gray-100 rounded flex items-center justify-center text-[10px] font-bold text-blue-600 uppercase">{file.file_name.split('.').pop()}</div>
                            <div className="ml-3 flex-1 min-w-0">
                              <p className="text-xs font-bold text-gray-900 truncate">{file.file_name}</p>
                              <p className="text-[10px] text-gray-500">{(file.file_size / 1024).toFixed(1)} KB</p>
                            </div>
                            <div className="flex space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <a href={file.file_url} target="_blank" rel="noreferrer" className="p-1.5 hover:bg-white hover:shadow-sm rounded text-gray-400 hover:text-blue-600"><Eye size={14} /></a>
                              <a href={file.file_url} target="_blank" rel="noreferrer" download={file.file_name} className="p-1.5 hover:bg-white hover:shadow-sm rounded text-gray-400 hover:text-green-600"><Download size={14} /></a>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-8 border-2 border-dashed border-gray-100 rounded-xl"><p className="text-xs text-gray-400 italic">No files attached.</p></div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <ProductionWorkflow order={order} />
            )}
          </div>

          <div className="space-y-6 no-print">
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
              <h2 className="text-sm font-black text-gray-900 uppercase tracking-widest mb-4">Status & Action</h2>
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-2">Update Workflow</label>
                  <select className="w-full text-sm font-bold border-gray-200 rounded-xl p-3 bg-gray-50 outline-none" value={status} onChange={(e) => setStatus(e.target.value as any)}>
                    <option value="draft">Draft</option>
                    <option value="submitted">Submitted</option>
                    <option value="in_review">In Review</option>
                    <option value="sampling_in_progress">Sampling</option>
                    <option value="ready">Ready</option>
                    <option value="dispatched">Dispatched</option>
                  </select>
                </div>
                {status === 'dispatched' && (
                  <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl space-y-3 animate-in fade-in slide-in-from-top-2">
                    <div><label className="text-[9px] font-black text-gray-400 uppercase block mb-1">Courier</label><input className="w-full text-xs font-bold p-2 border border-gray-200 rounded-lg" value={courierName} onChange={(e) => setCourierName(e.target.value)} /></div>
                    <div><label className="text-[9px] font-black text-gray-400 uppercase block mb-1">Tracking #</label><input className="w-full text-xs font-bold p-2 border border-gray-200 rounded-lg" value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} /></div>
                    <div><label className="text-[9px] font-black text-gray-400 uppercase block mb-1">Date</label><input type="date" className="w-full text-xs font-bold p-2 border border-gray-200 rounded-lg" value={dispatchedAt} onChange={(e) => setDispatchedAt(e.target.value)} /></div>
                  </div>
                )}
                <button onClick={handleUpdateStatus} disabled={updating} className="w-full bg-blue-600 text-white py-3 rounded-xl text-sm font-black shadow-lg shadow-blue-500/20 transition-all uppercase tracking-widest disabled:opacity-50">
                  {updating ? 'Updating...' : 'Save Workflow'}
                </button>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
              <h2 className="text-sm font-bold text-gray-900 mb-4">Management</h2>
              <div className="space-y-3">
                <button onClick={() => setShowAddStyleModal(true)} className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 rounded-lg text-xs font-bold text-gray-700 hover:bg-blue-50 hover:text-blue-600 transition-all"><span>Add Style</span><Plus size={14} /></button>
                <button onClick={() => setShowUploadModal(true)} className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 rounded-lg text-xs font-bold text-gray-700 hover:bg-blue-50 hover:text-blue-600 transition-all"><span>Upload Files</span><Upload size={14} /></button>
                <button onClick={() => router.push(`/orders/${order.id}/edit`)} className="w-full flex items-center justify-between px-4 py-3 border border-blue-100 text-blue-600 rounded-lg text-xs font-bold hover:bg-blue-600 hover:text-white transition-all"><span>Full Order Edit</span><Edit size={14} /></button>
                <button 
                  onClick={handleDeleteOrder} 
                  disabled={updating}
                  className="w-full flex items-center justify-between px-4 py-3 border border-red-100 text-red-600 rounded-lg text-xs font-bold hover:bg-red-600 hover:text-white transition-all mt-4"
                >
                  <span>Delete Order</span><Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      <Modal isOpen={showUploadModal} onClose={() => setShowUploadModal(false)} title="Upload Design Files" size="md">
        <div className="space-y-4">
          <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center bg-gray-50">
            <input type="file" multiple className="hidden" id="file-upload" onChange={(e) => setSelectedFiles(Array.from(e.target.files || []))} />
            <label htmlFor="file-upload" className="cursor-pointer flex flex-col items-center">
              <div className="bg-white h-12 w-12 rounded-full shadow-sm border border-gray-100 flex items-center justify-center mb-3 text-blue-600"><Upload size={20} /></div>
              <p className="text-xs font-bold text-gray-900">Click to Select Files</p>
            </label>
          </div>
          {selectedFiles.length > 0 && (
            <div className="space-y-2">
              {selectedFiles.map((f, i) => (
                <div key={i} className="flex justify-between items-center bg-white border p-2 rounded text-[10px] font-bold"><span className="truncate max-w-[200px]">{f.name}</span><button onClick={() => setSelectedFiles(selectedFiles.filter((_, idx) => idx !== i))} className="text-red-500"><X size={12} /></button></div>
              ))}
            </div>
          )}
          <div className="flex justify-end pt-4 border-t"><button onClick={handleUploadFiles} disabled={isUploading || selectedFiles.length === 0} className="px-6 py-2 bg-blue-600 text-white rounded-lg text-xs font-bold disabled:opacity-50">Upload</button></div>
        </div>
      </Modal>

      <Modal isOpen={showAddStyleModal} onClose={() => setShowAddStyleModal(false)} title="Add Quick Style">
         <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
               <div><label className="text-[10px] font-bold text-gray-400 uppercase mb-1 block">Item Number *</label><input className="w-full border-gray-100 rounded-lg text-xs p-2.5 bg-gray-50" value={newStyle.item_number} onChange={(e) => setNewStyle({...newStyle, item_number: e.target.value})} /></div>
               <div><label className="text-[10px] font-bold text-gray-400 uppercase mb-1 block">Style Name *</label><input className="w-full border-gray-100 rounded-lg text-xs p-2.5 bg-gray-50" value={newStyle.style_name} onChange={(e) => setNewStyle({...newStyle, style_name: e.target.value})} /></div>
            </div>
            <button onClick={handleSaveNewStyle} disabled={addingStyle} className="w-full py-2.5 bg-blue-600 text-white rounded-lg text-xs font-bold shadow-md">Add Style</button>
         </div>
      </Modal>
    </div>
  );
}