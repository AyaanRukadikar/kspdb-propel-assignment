/**
 * AI Summary Generator
 * 
 * Generates plain-English incident summaries for operators.
 * Uses template-based generation by default, with optional LLM enhancement
 * when OPENAI_API_KEY is set.
 * 
 * Design rationale: The fault LOCALIZATION is deterministic graph traversal —
 * an LLM has no business doing that. But COMMUNICATING the result to a
 * non-engineer at 2 AM is where natural language adds value. The LLM
 * takes structured fault data and produces actionable prose.
 * 
 * Fallback: Template-based summaries always work, even without an API key.
 * Cost: ~$0.002 per summary using GPT-4o-mini.
 */

const FAULT_TYPE_LABELS = {
  span: 'Line Span Fault',
  dt: 'Distribution Transformer Fault',
  feeder: 'Feeder-Level Fault',
  unknown: 'Unknown Fault',
};

const SEVERITY_LABELS = {
  critical: '🔴 CRITICAL',
  high: '🟠 HIGH',
  medium: '🟡 MEDIUM',
  low: '🟢 LOW',
};

/**
 * Generate a template-based summary (always available, no API key needed)
 */
function generateTemplateSummary(data) {
  const faultLabel = FAULT_TYPE_LABELS[data.faultType] || 'Fault';
  
  let summary = '';
  
  if (data.faultType === 'span') {
    summary = `${faultLabel} detected on the span between pole ${data.spanStart} and pole ${data.spanEnd}. `;
    summary += `${data.affectedCount} pole(s) affected downstream, impacting approximately ${data.householdsAffected} households. `;
    summary += `Location: PIN ${data.pincode}. `;
    
    if (data.topologySource === 'inferred') {
      summary += `⚠️ Pole ordering was inferred from GPS coordinates — actual span may differ by ±1 pole. `;
    }
    
    summary += `Confidence: ${Math.round(data.confidence * 100)}%.`;
    
  } else if (data.faultType === 'dt') {
    summary = `${faultLabel} — all poles under transformer ${data.dtId} are dark. `;
    summary += `This affects ${data.affectedCount} poles and approximately ${data.householdsAffected} households. `;
    summary += `Likely cause: DT failure, HT fuse blown, or upstream supply issue. `;
    summary += `Check transformer and HT connections first.`;
    
  } else if (data.faultType === 'feeder') {
    summary = `${faultLabel} — all transformers on feeder ${data.feederId} are dark. `;
    summary += `This is a major outage affecting ${data.affectedCount} poles. `;
    summary += `Cause is likely at the 11kV feeder level. Escalate to feeder maintenance crew immediately.`;
  }
  
  return summary;
}

/**
 * Generate a summary using LLM (when available)
 */
async function generateLLMSummary(data) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  
  try {
    const prompt = `You are a power grid control room assistant. Generate a brief, actionable summary for a control room operator who is not an engineer. Be direct and specific.

Fault data:
- Type: ${FAULT_TYPE_LABELS[data.faultType]}
- ${data.faultType === 'span' ? `Span: ${data.spanStart} → ${data.spanEnd}` : ''}
- DT: ${data.dtId || 'N/A'}
- Feeder: ${data.feederId || 'N/A'}
- Poles affected: ${data.affectedCount}
- Households affected: ~${data.householdsAffected}
- PIN code: ${data.pincode}
- Confidence: ${Math.round(data.confidence * 100)}%
- Topology source: ${data.topologySource}

Write 2-3 sentences. Include: what happened, where, how bad, and what to do first.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });
    
    if (!response.ok) return null;
    
    const result = await response.json();
    return result.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.log('[AI Summary] LLM unavailable, using template:', err.message);
    return null;
  }
}

/**
 * Generate summary — tries LLM first, falls back to template
 */
function generateSummary(data) {
  // Always use template for synchronous ticket creation
  // LLM can be used for async enhancement later
  return generateTemplateSummary(data);
}

/**
 * Async version that tries LLM first
 */
async function generateSummaryAsync(data) {
  const llmSummary = await generateLLMSummary(data);
  return llmSummary || generateTemplateSummary(data);
}

module.exports = {
  generateSummary,
  generateSummaryAsync,
  generateTemplateSummary,
};
