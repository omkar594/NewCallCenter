import { useEffect, useState } from 'react';
import { RadioTower, AlertCircle } from 'lucide-react';
import { apiGet } from '../../api/client.js';

export default function GatewayPorts() {
  const [gateways, setGateways] = useState([]);
  const [ports, setPorts] = useState([]);
  const [error, setError] = useState('');
  const [liveStatus, setLiveStatus] = useState({}); // gatewayId -> { loading, data, error }

  useEffect(() => {
    Promise.all([apiGet('/api/gateways'), apiGet('/api/gateways/ports')])
      .then(([g, p]) => {
        setGateways(g);
        setPorts(p);
      })
      .catch((err) => setError(err.message));
  }, []);

  const checkLive = async (gatewayId) => {
    setLiveStatus((prev) => ({ ...prev, [gatewayId]: { loading: true } }));
    try {
      const data = await apiGet(`/api/gateways/${gatewayId}/live`);
      setLiveStatus((prev) => ({ ...prev, [gatewayId]: { data } }));
    } catch (err) {
      setLiveStatus((prev) => ({ ...prev, [gatewayId]: { error: err.message } }));
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Gateways &amp; Ports</h1>
        <p className="text-sm text-slate-500 dark:text-abyss-50">Every SIM port across every gateway, and who owns it.</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {gateways.map((gw) => {
        const gwPorts = ports.filter((p) => p.gateway_name === gw.name);
        const status = liveStatus[gw.id];
        return (
          <section key={gw.id} className="bg-white dark:bg-abyss-500 border border-slate-200 dark:border-abyss-300/30 rounded-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RadioTower className="w-5 h-5 text-slate-400 dark:text-abyss-100" />
                <div>
                  <div className="font-medium text-slate-900 dark:text-white">{gw.name}</div>
                  <div className="text-xs text-slate-500 dark:text-abyss-50">{gw.ip_address}</div>
                </div>
              </div>
              <button
                onClick={() => checkLive(gw.id)}
                className="text-sm px-3 py-1.5 rounded-md border border-slate-300 dark:border-abyss-200/50 hover:border-brand-500 dark:hover:border-neon-cyan/60 text-slate-700 dark:text-slate-200"
              >
                {status?.loading ? 'Checking...' : 'Check Live Status'}
              </button>
            </div>

            {status?.error && (
              <div className="text-sm text-amber-700 bg-amber-50 rounded-md px-3 py-2">
                {status.error} - the physical gateway may be offline; port assignment below still works regardless.
              </div>
            )}
            {status?.data && (
              <pre className="text-xs bg-slate-50 dark:bg-abyss-400/40 rounded-md p-3 overflow-x-auto">{JSON.stringify(status.data.live_ports, null, 2)}</pre>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {gwPorts.map((p) => (
                <div key={p.port_number} className="border border-slate-200 dark:border-abyss-300/30 rounded-md px-3 py-2 text-sm">
                  <div className="font-medium text-slate-900 dark:text-white">Port {p.port_number}</div>
                  <div className="text-xs text-slate-500 dark:text-abyss-50 truncate">{p.tenant_name || 'free'}</div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
