import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, AlertCircle, CheckCircle2, UploadCloud, Play, Languages, Loader2 } from 'lucide-react';
import { apiGet, apiPost, apiPut, apiPostAudioBlob } from '../../api/client.js';

const NODE_TYPES = ['play', 'menu', 'collect_input', 'lookup', 'branch', 'transfer_queue', 'sms', 'optout', 'amd_check', 'hangup'];
const PROMPT_TYPES = new Set(['play', 'menu', 'collect_input', 'optout']);
const PROMPT_REQUIRED_TYPES = new Set(['play', 'menu']);
const BRANCH_TYPES = new Set(['menu', 'lookup', 'branch', 'amd_check']);
// Matches the languages Piper actually has voice models for (see backend .env.example's
// PIPER_VOICE_MODELS) - a flow node has no language of its own (that's set per-lead at campaign
// time), so this is purely for the preview/transliterate tools below to know which voice/script
// to target while authoring.
const TTS_LANGUAGES = [
  { code: 'en-US', label: 'English' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'mr-IN', label: 'Marathi' }
];
// Only hi-IN/mr-IN need Latin-to-native-script transliteration - see utils/transliteration.js.
const TRANSLITERATABLE_LANGUAGES = new Set(['hi-IN', 'mr-IN']);

let localIdCounter = 0;
const newLocalId = () => `new-${Date.now()}-${localIdCounter++}`;

function blankNode(isFirst) {
  return {
    client_id: newLocalId(),
    type: 'play',
    is_start: isFirst,
    promptMode: 'text',
    prompt_text: '',
    prompt_id: '',
    next: '',
    branches: [],
    configText: '{}',
    // UI-only, authoring-time state - which voice/script the preview and transliterate tools
    // below target. Never sent to the backend (see handleSave's payload, which picks fields
    // explicitly).
    previewLanguage: 'hi-IN'
  };
}

// The GET /flows/:id response identifies nodes by real DB UUIDs (n.id) and next/branch targets
// point at those same UUIDs - reusing n.id directly as this editor's client_id means every
// next/branch reference already lines up with no remapping. updateFlow does a full
// delete-and-re-insert anyway, so submitting the old id back as a "client_id" is harmless - the
// backend treats it as just another caller-chosen string and mints a fresh row/UUID for it.
function nodesFromServer(serverNodes) {
  return serverNodes.map((n) => ({
    client_id: n.id,
    type: n.type,
    is_start: n.is_start,
    promptMode: n.prompt_text ? 'text' : 'audio',
    prompt_text: n.prompt_text || '',
    prompt_id: n.prompt_id || '',
    next: n.next || '',
    branches: n.branches ? Object.entries(n.branches).map(([matchValue, b]) => ({ matchValue, target: b.target, label: b.label || '' })) : [],
    configText: JSON.stringify(n.config || {}, null, 2),
    previewLanguage: 'hi-IN'
  }));
}

export default function FlowEditor() {
  const { flowId } = useParams();
  const navigate = useNavigate();
  const isNew = !flowId;

  const [name, setName] = useState('');
  const [nodes, setNodes] = useState(() => [blankNode(true)]);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isNew) return;
    apiGet(`/api/ivr/flows/${flowId}`)
      .then((flow) => {
        setName(flow.name);
        setNodes(nodesFromServer(flow.nodes));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [flowId, isNew]);

  const updateNode = (index, patch) => {
    setNodes((prev) => prev.map((n, i) => (i === index ? { ...n, ...patch } : n)));
  };

  const addNode = () => setNodes((prev) => [...prev, blankNode(false)]);

  const removeNode = (index) => setNodes((prev) => prev.filter((_, i) => i !== index));

  const setAsStart = (index) => {
    setNodes((prev) => prev.map((n, i) => ({ ...n, is_start: i === index })));
  };

  const validate = () => {
    const errors = [];
    if (!name.trim()) errors.push('Flow name is required.');
    if (nodes.length === 0) errors.push('At least one node is required.');
    const ids = new Set();
    for (const n of nodes) {
      if (!n.client_id) errors.push('Every node needs an ID.');
      if (ids.has(n.client_id)) errors.push(`Duplicate node ID "${n.client_id}".`);
      ids.add(n.client_id);
      if (PROMPT_REQUIRED_TYPES.has(n.type)) {
        const hasPrompt = n.promptMode === 'text' ? !!n.prompt_text.trim() : !!n.prompt_id.trim();
        if (!hasPrompt) errors.push(`Node "${n.client_id}" (${n.type}) needs a prompt.`);
      }
      try {
        JSON.parse(n.configText || '{}');
      } catch (e) {
        errors.push(`Node "${n.client_id}" has invalid JSON in Advanced Config.`);
      }
    }
    if (nodes.filter((n) => n.is_start).length !== 1) errors.push('Exactly one node must be marked as the start node.');
    for (const n of nodes) {
      if (n.next && !ids.has(n.next)) errors.push(`Node "${n.client_id}"'s "next" points at an unknown node.`);
      for (const b of n.branches) {
        if (b.target && !ids.has(b.target)) errors.push(`Node "${n.client_id}"'s branch "${b.matchValue}" points at an unknown node.`);
      }
    }
    return errors;
  };

  const handleSave = async () => {
    setError('');
    setSuccess('');
    const errors = validate();
    if (errors.length) {
      setError(errors.join(' '));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name,
        nodes: nodes.map((n) => ({
          client_id: n.client_id,
          type: n.type,
          is_start: n.is_start,
          prompt_text: n.promptMode === 'text' ? n.prompt_text || undefined : undefined,
          prompt_id: n.promptMode === 'audio' ? n.prompt_id || undefined : undefined,
          next: n.next || undefined,
          branches: n.branches.length ? Object.fromEntries(n.branches.map((b) => [b.matchValue, { target: b.target, label: b.label || undefined }])) : undefined,
          config: JSON.parse(n.configText || '{}')
        }))
      };
      if (isNew) {
        const created = await apiPost('/api/ivr/flows', payload);
        setSuccess('Flow created.');
        navigate(`/app/flows/${created.id}`, { replace: true });
      } else {
        await apiPut(`/api/ivr/flows/${flowId}`, payload);
        setSuccess('Flow saved.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-sm text-slate-500 dark:text-abyss-50">Loading...</p>;

  return (
    <div className="space-y-6 pb-16">
      <button onClick={() => navigate('/app/flows')} className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-abyss-50 hover:text-slate-700">
        <ArrowLeft className="w-4 h-4" /> All flows
      </button>

      <div>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">Flow name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Account Balance Flow"
          className="w-full max-w-md border border-slate-300 dark:border-abyss-200/50 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-neon-cyan/50"
        />
      </div>

      <div className="space-y-4">
        {nodes.map((node, index) => (
          <NodeCard
            key={node.client_id}
            node={node}
            index={index}
            allNodes={nodes}
            onChange={(patch) => updateNode(index, patch)}
            onRemove={() => removeNode(index)}
            onSetStart={() => setAsStart(index)}
            canRemove={nodes.length > 1}
          />
        ))}
      </div>

      <button
        onClick={addNode}
        className="flex items-center gap-2 text-sm text-brand-600 dark:text-neon-cyan hover:text-brand-700 border border-dashed border-brand-300 rounded-lg px-4 py-3 w-full justify-center"
      >
        <Plus className="w-4 h-4" /> Add Node
      </button>

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-neon-green bg-emerald-50 dark:bg-neon-green/10 rounded-md px-3 py-2">
          <CheckCircle2 className="w-4 h-4" /> {success}
        </div>
      )}

      <div className="sticky bottom-0 bg-slate-50 dark:bg-abyss-400/40 pt-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium px-6 py-2.5 rounded-md shadow"
        >
          {saving ? 'Saving...' : isNew ? 'Create Flow' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

function NodeCard({ node, index, allNodes, onChange, onRemove, onSetStart, canRemove }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [transliterating, setTransliterating] = useState(false);
  const [ttsToolError, setTtsToolError] = useState('');
  // Shown as a separate suggestion, not auto-applied - the author's original typed text stays
  // untouched in the textarea until they explicitly click "Use this text".
  const [transliterationSuggestion, setTransliterationSuggestion] = useState('');
  const audioRef = useRef(null);
  const otherNodes = allNodes.filter((n) => n.client_id !== node.client_id);

  // Synthesizes and plays the prompt right here, so a flow author can check pronunciation
  // without a live test call. This hits the exact same synthesis path a real campaign call
  // does, so it also warms the backend's in-memory TTS cache for this text+language - a
  // campaign created afterward with this same prompt skips re-synthesizing at "preparing" time
  // (as long as the backend process hasn't restarted since).
  const handlePreview = async () => {
    setTtsToolError('');
    setPreviewing(true);
    try {
      const blob = await apiPostAudioBlob('/api/ivr/preview-tts', {
        text: node.prompt_text,
        languageCode: node.previewLanguage
      });
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.src = url;
        await audioRef.current.play();
      }
    } catch (err) {
      setTtsToolError(err.message);
    } finally {
      setPreviewing(false);
    }
  };

  // Converts whatever's typed (usually Hinglish) into the target language's native script -
  // Piper's phonemizer expects that, not a Latin transliteration. Shown as a separate suggestion
  // below the textarea (see transliterationSuggestion) rather than silently overwriting what the
  // author typed - they compare the two and explicitly opt in via "Use this text".
  const handleTransliterate = async () => {
    setTtsToolError('');
    setTransliterationSuggestion('');
    setTransliterating(true);
    try {
      const { transliterated } = await apiPost('/api/ivr/transliterate', {
        text: node.prompt_text,
        languageCode: node.previewLanguage
      });
      setTransliterationSuggestion(transliterated);
    } catch (err) {
      setTtsToolError(err.message);
    } finally {
      setTransliterating(false);
    }
  };

  const applyTransliteration = () => {
    onChange({ prompt_text: transliterationSuggestion });
    setTransliterationSuggestion('');
  };

  const handleAudioUpload = async (file) => {
    setUploadError('');
    setUploading(true);
    try {
      const form = new FormData();
      form.append('audio', file);
      const data = await apiPost('/api/ivr/prompts', form);
      onChange({ prompt_id: data.prompt_id });
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const addBranch = () => onChange({ branches: [...node.branches, { matchValue: '', target: '', label: '' }] });
  const updateBranch = (i, patch) =>
    onChange({ branches: node.branches.map((b, idx) => (idx === i ? { ...b, ...patch } : b)) });
  const removeBranch = (i) => onChange({ branches: node.branches.filter((_, idx) => idx !== i) });

  // The lookup node's dedicated fields below read/write the SAME configText every other node
  // type only exposes via the raw JSON fallback - structured fields and the JSON view stay in
  // sync because they share this one source of truth, so a power user can still hand-edit
  // anything the structured UI doesn't cover.
  let parsedConfig = {};
  try {
    parsedConfig = JSON.parse(node.configText || '{}');
  } catch (e) {
    // Invalid JSON - leave parsedConfig empty; validate() at save time is what surfaces this.
  }
  const patchConfig = (patch) => onChange({ configText: JSON.stringify({ ...parsedConfig, ...patch }, null, 2) });

  return (
    <div className="bg-white dark:bg-abyss-500 border border-slate-200 dark:border-abyss-300/30 rounded-lg p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-mono text-slate-400 dark:text-abyss-100">#{index + 1}</span>
          <input
            value={node.client_id}
            onChange={(e) => onChange({ client_id: e.target.value })}
            className="border border-slate-300 dark:border-abyss-200/50 rounded-md px-2 py-1 text-sm font-mono w-40"
            placeholder="node_id"
          />
          <select
            value={node.type}
            onChange={(e) => onChange({ type: e.target.value })}
            className="border border-slate-300 dark:border-abyss-200/50 rounded-md px-2 py-1 text-sm"
          >
            {NODE_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <input type="radio" checked={node.is_start} onChange={onSetStart} />
            Start node
          </label>
        </div>
        {canRemove && (
          <button onClick={onRemove} className="text-slate-400 dark:text-abyss-100 hover:text-red-600">
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {PROMPT_TYPES.has(node.type) && (
        <div className="space-y-2">
          <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-abyss-50">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={node.promptMode === 'text'} onChange={() => onChange({ promptMode: 'text' })} />
              Type text (TTS)
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={node.promptMode === 'audio'} onChange={() => onChange({ promptMode: 'audio' })} />
              Upload audio
            </label>
            {PROMPT_REQUIRED_TYPES.has(node.type) && <span className="text-slate-400 dark:text-abyss-100">(required for {node.type})</span>}
          </div>
          {node.promptMode === 'text' ? (
            <div className="space-y-2">
              <textarea
                value={node.prompt_text}
                onChange={(e) => onChange({ prompt_text: e.target.value })}
                placeholder="Press 1 to check your balance. Press 9 to end this call. Use {{variable}} for values set earlier in the flow."
                rows={2}
                className="w-full border border-slate-300 dark:border-abyss-200/50 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-neon-cyan/50"
              />
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={node.previewLanguage}
                  onChange={(e) => onChange({ previewLanguage: e.target.value })}
                  className="border border-slate-300 dark:border-abyss-200/50 rounded-md px-2 py-1 text-xs text-slate-600 dark:text-slate-300"
                >
                  {TTS_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.label}</option>
                  ))}
                </select>
                {TRANSLITERATABLE_LANGUAGES.has(node.previewLanguage) && (
                  <button
                    type="button"
                    onClick={handleTransliterate}
                    disabled={transliterating || !node.prompt_text.trim()}
                    className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-abyss-400/40 hover:bg-slate-100 rounded-md px-2 py-1 disabled:opacity-50"
                  >
                    {transliterating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Languages className="w-3 h-3" />}
                    Suggest {node.previewLanguage === 'mr-IN' ? 'Marathi script' : 'Devanagari'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handlePreview}
                  disabled={previewing || !node.prompt_text.trim()}
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 dark:text-neon-cyan bg-brand-50 dark:bg-neon-cyan/10 hover:bg-brand-100 rounded-md px-2 py-1 disabled:opacity-50"
                >
                  {previewing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                  Preview
                </button>
                <audio ref={audioRef} className="hidden" />
              </div>
              {transliterationSuggestion && (
                <div className="flex items-start gap-2 bg-brand-50 dark:bg-neon-cyan/10 border border-brand-200 dark:border-neon-cyan/20 rounded-md px-3 py-2">
                  <p className="flex-1 text-sm text-slate-800 dark:text-white">{transliterationSuggestion}</p>
                  <button
                    type="button"
                    onClick={applyTransliteration}
                    className="shrink-0 text-xs font-medium text-brand-700 dark:text-neon-cyan hover:text-brand-800 underline"
                  >
                    Use this text
                  </button>
                  <button
                    type="button"
                    onClick={() => setTransliterationSuggestion('')}
                    className="shrink-0 text-xs text-slate-400 dark:text-abyss-100 hover:text-slate-600 dark:hover:text-white"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {ttsToolError && <p className="text-xs text-red-600 dark:text-red-300">{ttsToolError}</p>}
            </div>
          ) : (
            <div>
              <label className="flex items-center gap-2 border-2 border-dashed border-slate-300 dark:border-abyss-200/50 rounded-md px-3 py-2 text-sm cursor-pointer hover:border-brand-500 dark:hover:border-neon-cyan/60">
                <UploadCloud className="w-4 h-4 text-slate-400 dark:text-abyss-100" />
                {node.prompt_id ? `Uploaded: ${node.prompt_id}` : uploading ? 'Uploading...' : 'Choose audio file'}
                <input type="file" accept="audio/*" className="hidden" onChange={(e) => e.target.files?.[0] && handleAudioUpload(e.target.files[0])} />
              </label>
              {uploadError && <p className="text-xs text-red-600 dark:text-red-300 mt-1">{uploadError}</p>}
            </div>
          )}
        </div>
      )}

      {node.type === 'lookup' && (
        <div className="space-y-3 border border-slate-200 dark:border-abyss-300/30 rounded-md p-3 bg-slate-50 dark:bg-abyss-400/40">
          <div className="flex items-center gap-4 text-xs text-slate-600 dark:text-slate-300">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={(parsedConfig.source_type || 'table') === 'table'}
                onChange={() => patchConfig({ source_type: 'table' })}
              />
              Uploaded table (CSV)
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={parsedConfig.source_type === 'webhook'}
                onChange={() => patchConfig({ source_type: 'webhook' })}
              />
              Connect the client's own database (via their API)
            </label>
          </div>

          {parsedConfig.source_type === 'webhook' ? (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Webhook URL</label>
                <input
                  value={parsedConfig.webhook_url || ''}
                  onChange={(e) => patchConfig({ webhook_url: e.target.value })}
                  placeholder="https://your-backend.example.com/lookup"
                  className="w-full border border-slate-300 dark:border-abyss-200/50 rounded-md px-2 py-1.5 text-sm"
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-abyss-50">
                  Your own endpoint - it queries your real database however you like, we never see your DB credentials. We POST{' '}
                  <code className="bg-white dark:bg-abyss-500 px-1 rounded">{'{ input: { [lookup_key]: value } }'}</code>, you respond with{' '}
                  <code className="bg-white dark:bg-abyss-500 px-1 rounded">{'{ status: "found"|"not_found", data: {...} }'}</code>.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Authorization header (optional)</label>
                <input
                  value={parsedConfig.webhook_auth_header || ''}
                  onChange={(e) => patchConfig({ webhook_auth_header: e.target.value })}
                  placeholder="Bearer your-api-token"
                  className="w-full border border-slate-300 dark:border-abyss-200/50 rounded-md px-2 py-1.5 text-sm"
                />
              </div>
            </>
          ) : (
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Lookup Table ID</label>
              <input
                value={parsedConfig.table_id || ''}
                onChange={(e) => patchConfig({ table_id: e.target.value })}
                placeholder="paste the ID copied from Lookup Tables"
                className="w-full border border-slate-300 dark:border-abyss-200/50 rounded-md px-2 py-1.5 text-sm font-mono"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Lookup key</label>
              <input
                value={parsedConfig.lookup_key || ''}
                onChange={(e) => patchConfig({ lookup_key: e.target.value })}
                placeholder="account_number"
                className="w-full border border-slate-300 dark:border-abyss-200/50 rounded-md px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Response variable prefix</label>
              <input
                value={parsedConfig.response_var_prefix || ''}
                onChange={(e) => patchConfig({ response_var_prefix: e.target.value })}
                placeholder="account_"
                className="w-full border border-slate-300 dark:border-abyss-200/50 rounded-md px-2 py-1.5 text-sm"
              />
            </div>
          </div>
        </div>
      )}

      {BRANCH_TYPES.has(node.type) ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">Branches</label>
            <button onClick={addBranch} className="text-xs text-brand-600 dark:text-neon-cyan hover:underline">+ add branch</button>
          </div>
          {node.branches.map((b, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={b.matchValue}
                onChange={(e) => updateBranch(i, { matchValue: e.target.value })}
                placeholder={node.type === 'lookup' ? 'found / not_found / error' : 'match value (e.g. 1, human)'}
                className="border border-slate-300 dark:border-abyss-200/50 rounded-md px-2 py-1 text-sm flex-1"
              />
              <span className="text-slate-400 dark:text-abyss-100 text-xs">-&gt;</span>
              <select
                value={b.target}
                onChange={(e) => updateBranch(i, { target: e.target.value })}
                className="border border-slate-300 dark:border-abyss-200/50 rounded-md px-2 py-1 text-sm flex-1"
              >
                <option value="">choose node</option>
                {otherNodes.map((n) => (
                  <option key={n.client_id} value={n.client_id}>{n.client_id} ({n.type})</option>
                ))}
              </select>
              {/* Shown to Super Admin/tenant on the campaign report's "DTMF Pressed" column
                  (CampaignDetail.jsx) instead of the raw matchValue - e.g. "1" reads as
                  "Sales" once labeled. Optional: falls back to the raw digit if left blank. */}
              <input
                value={b.label}
                onChange={(e) => updateBranch(i, { label: e.target.value })}
                placeholder="report label (optional)"
                className="border border-slate-300 dark:border-abyss-200/50 rounded-md px-2 py-1 text-sm flex-1"
              />
              <button onClick={() => removeBranch(i)} className="text-slate-400 dark:text-abyss-100 hover:text-red-600">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        node.type !== 'hangup' && (
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Next node</label>
            <select
              value={node.next}
              onChange={(e) => onChange({ next: e.target.value })}
              className="border border-slate-300 dark:border-abyss-200/50 rounded-md px-2 py-1 text-sm w-64"
            >
              <option value="">(none - ends the call)</option>
              {otherNodes.map((n) => (
                <option key={n.client_id} value={n.client_id}>{n.client_id} ({n.type})</option>
              ))}
            </select>
          </div>
        )
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 dark:text-abyss-50 hover:text-slate-700">Advanced config (JSON)</summary>
        <textarea
          value={node.configText}
          onChange={(e) => onChange({ configText: e.target.value })}
          rows={4}
          spellCheck={false}
          className="mt-2 w-full border border-slate-300 dark:border-abyss-200/50 rounded-md px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-neon-cyan/50"
        />
        <p className="mt-1 text-slate-400 dark:text-abyss-100">
          {node.type === 'collect_input' && 'e.g. {"max_digits": 10, "min_digits": 10, "terminator": "#", "store_as": "account_number"}'}
          {node.type === 'lookup' && 'source_type/table_id/webhook_url/lookup_key/response_var_prefix are already set by the section above - this is only for anything extra.'}
        </p>
      </details>
    </div>
  );
}
