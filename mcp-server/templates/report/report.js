// Tessa report page. Built entirely with DOM APIs (createElement, textContent): nothing from the
// results, which include text read from the app under test, is ever parsed as HTML.
(() => {
  'use strict';

  const data = JSON.parse(document.getElementById('tessa-data').textContent);
  const results = data.results;
  const planById = new Map(data.tests.map((t) => [t.id, t]));
  const selected = new Set();
  const filters = { status: '', persona: '' };
  // Served by tessa-mcp at http://127.0.0.1:<port>/<token>/; opened from disk otherwise.
  const served = location.protocol === 'http:' && location.hostname === '127.0.0.1';

  // Failures first, so the reviewer sees what needs attention without scrolling.
  const STATUS_ORDER = { failed: 0, error: 1, passed: 2, skipped: 3 };
  const STATUS_LABEL = { failed: 'Failed', error: 'Error', passed: 'Passed', skipped: 'Skipped' };
  const tests = results.tests
    .filter((t) => planById.has(t.test_id))
    .map((t, i) => ({ result: t, plan: planById.get(t.test_id), order: i }))
    .sort(
      (a, b) => STATUS_ORDER[a.result.status] - STATUS_ORDER[b.result.status] || a.order - b.order,
    );

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'className') node.className = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children || []) {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
  }

  function chevron() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'chevron');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M6 3.5 10.5 8 6 12.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  // Screenshot paths come from results.json, which tessa-mcp wrote; still, only allow the
  // relative screenshots/ paths it produces.
  function safeImage(path) {
    return typeof path === 'string' &&
      /^screenshots\/[a-z0-9-]+\/[0-9]+-[0-9]+\.(png|jpg|webp)$/.test(path)
      ? path
      : null;
  }

  function formatMs(ms) {
    if (typeof ms !== 'number') return '';
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    const minutes = Math.floor(ms / 60_000);
    return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
  }

  function statusBadge(status) {
    const known = STATUS_LABEL[status];
    return el('span', {
      className: `status status-${known ? status : 'not-run'}`,
      text: known || 'Not run',
    });
  }

  function describeStep(step) {
    const t = step.target;
    const parts = [step.action];
    if (t) {
      parts.push(
        t.strategy === 'role'
          ? `role=${t.role}${t.name ? ` "${t.name}"` : ''}`
          : `${t.strategy}="${t.value}"`,
      );
    }
    if (step.value !== undefined) parts.push(`"${step.value}"`);
    if (step.value_env) parts.push(`$${step.value_env}`);
    if (step.assertion) {
      const a = step.assertion;
      parts.push(a.expected === undefined ? a.kind : `${a.kind} ${JSON.stringify(a.expected)}`);
    }
    return parts.join(' ');
  }

  function formatValue(value) {
    if (Array.isArray(value)) return value.length ? value.join(', ') : null;
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join(', ') : null;
    }
    return value === undefined || value === '' ? null : String(value);
  }

  function facts(rows) {
    const shown = rows
      .map(([label, value]) => [label, formatValue(value)])
      .filter(([, value]) => value !== null);
    return el(
      'dl',
      { className: 'facts' },
      shown.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: value })]),
    );
  }

  function screenshotButton(path, caption) {
    const image = safeImage(path);
    if (!image) return null;
    const button = el(
      'button',
      { type: 'button', className: 'shot', 'aria-label': `View screenshot: ${caption}` },
      [el('img', { src: image, alt: '', loading: 'lazy' })],
    );
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openLightbox(image, caption);
    });
    return button;
  }

  // Header

  function renderHeader() {
    document.getElementById('story-title').textContent = data.story.title;
    const env = results.environment;
    const meta = document.getElementById('run-meta');
    for (const bit of [
      `Run ${results.run_id}`,
      env.branch,
      env.commit ? `${env.commit.slice(0, 7)}${env.dirty ? ' (modified)' : ''}` : null,
      new Date(results.finished_at).toLocaleString(),
    ]) {
      if (bit) meta.append(el('span', { text: bit }));
    }
    const stats = document.getElementById('stats');
    const s = results.summary;
    stats.append(
      el('span', { className: 'stat', role: 'listitem' }, [
        el('strong', { text: s.total }),
        'tests',
      ]),
    );
    for (const key of ['passed', 'failed', 'error', 'skipped']) {
      if (s[key] > 0) {
        stats.append(
          el('span', { className: 'stat', role: 'listitem' }, [
            el('strong', { text: s[key] }),
            el('span', {
              className: `status status-${key}`,
              text: STATUS_LABEL[key].toLowerCase(),
            }),
          ]),
        );
      }
    }
    // Time spent in steps. The run's wall-clock time also includes sign-in pauses.
    const testTime = results.tests.reduce((sum, t) => sum + (t.duration_ms || 0), 0);
    if (testTime > 0) {
      stats.append(
        el('span', { className: 'stat', role: 'listitem', title: 'Time spent in test steps' }, [
          el('strong', { text: formatMs(testTime) }),
          'test time',
        ]),
      );
    }
    document.getElementById('export-target').textContent = `Exports to ${data.options.target}`;
  }

  // Tests

  function failureCallout(result, plan) {
    const f = result.failure;
    if (!f) return null;
    const step = plan.steps[f.step_index];
    const caption = `Step ${f.step_index + 1}${step ? `: ${step.description}` : ''}`;
    return el('div', { className: 'callout', role: 'note' }, [
      el('p', {
        className: 'callout-title',
        text: `${result.status === 'error' ? 'Stopped' : 'Failed'} at step ${f.step_index + 1}${step ? ` · ${step.description}` : ''}`,
      }),
      el('p', { className: 'callout-message', text: f.message }),
      f.expected || f.actual
        ? el('div', { className: 'compare' }, [
            el('div', {}, [
              el('span', { className: 'compare-label', text: 'Expected' }),
              el('p', { text: f.expected || '—' }),
            ]),
            el('div', {}, [
              el('span', { className: 'compare-label', text: 'Actual' }),
              el('p', { text: f.actual || '—' }),
            ]),
          ])
        : null,
      screenshotButton(f.screenshot, caption),
    ]);
  }

  function stepList(result, plan) {
    const byIndex = new Map(result.steps.map((s) => [s.index, s]));
    const failedIndex = result.failure ? result.failure.step_index : -1;
    return el(
      'ol',
      { className: 'steps' },
      plan.steps.map((step, index) => {
        const record = byIndex.get(index);
        return el('li', { className: `step${index === failedIndex ? ' is-failed' : ''}` }, [
          el('span', { className: 'step-number', text: index + 1 }),
          el('div', { className: 'step-text' }, [
            el('span', { text: step.description }),
            el('span', {
              className: 'step-action',
              text:
                record && record.selector_used
                  ? `${describeStep(step)} → ${record.selector_used}`
                  : describeStep(step),
              title: describeStep(step),
            }),
          ]),
          statusBadge(record ? record.status : null),
          screenshotButton(record && record.screenshot, `Step ${index + 1}: ${step.description}`) ||
            el('span', { className: 'no-shot', 'aria-hidden': 'true' }),
        ]);
      }),
    );
  }

  function detailsSection(result, plan) {
    const env = result.env_state;
    const q = result.quality || {};
    const rows = [
      ['Persona', env.persona],
      ['Role', env.role],
      ['Permissions', env.permissions],
      ['Settings', env.settings],
      ['Feature flags', env.feature_flags],
      ['Seed profile', env.seed_profile],
      ['Build', env.build],
      ['Selector stability', q.selector_stability],
      [
        'Rerun consistency',
        q.rerun_consistency === undefined ? undefined : `${Math.round(q.rerun_consistency * 100)}%`,
      ],
      ['Attempts', result.attempts],
    ];
    if (data.options.show_overlap) {
      rows.push([
        'Overlaps with',
        q.overlap_with && q.overlap_with.length ? q.overlap_with : 'None',
      ]);
    }
    if (result.triage) {
      rows.push([
        'Triage',
        `${result.triage.class} (${result.triage.confidence} confidence) — ${result.triage.rationale}`,
      ]);
    }
    if (plan.criteria && plan.criteria.length) rows.push(['Covers', plan.criteria]);
    const children = [el('summary', { text: 'Environment and quality' }), facts(rows)];
    const details = el('details', { className: 'details' }, children);
    if (!data.options.show_code_preview) return [details];
    return [
      details,
      el('details', { className: 'details' }, [
        el('summary', {
          text: `Test definition (${data.options.target} code arrives with export)`,
        }),
        el('pre', {}, [el('code', { text: JSON.stringify(plan, null, 2) })]),
      ]),
    ];
  }

  function testCard({ result, plan }) {
    const id = result.test_id;
    const bodyId = `body-${id}`;
    const checkbox = el('input', {
      type: 'checkbox',
      'aria-label': `Select ${plan.name}`,
      'data-test-id': id,
    });
    const toggle = el(
      'button',
      { type: 'button', className: 'toggle', 'aria-expanded': 'false', 'aria-controls': bodyId },
      [
        statusBadge(result.status),
        el('span', { className: 'toggle-text' }, [
          el('span', { className: 'test-name', text: plan.name }),
          result.failure
            ? el('span', { className: 'test-reason', text: result.failure.message })
            : null,
        ]),
        el('span', { className: 'tag', text: plan.persona }),
        el('span', { className: 'duration', text: formatMs(result.duration_ms) }),
      ],
    );
    const body = el('div', { className: 'test-body', id: bodyId, hidden: true }, [
      el('p', { className: 'intent', text: plan.intent }),
      failureCallout(result, plan),
      el('p', { className: 'section-label', text: `Steps (${plan.steps.length})` }),
      stepList(result, plan),
      ...detailsSection(result, plan),
    ]);
    const card = el(
      'article',
      {
        className: 'test',
        'data-status': result.status,
        'data-persona': plan.persona,
        'aria-label': plan.name,
      },
      [el('div', { className: 'test-row' }, [checkbox, toggle, chevron()]), body],
    );

    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      card.classList.toggle('is-open', open);
    });
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(id);
      else selected.delete(id);
      card.classList.toggle('is-selected', checkbox.checked);
      updateFooter();
    });
    return card;
  }

  // Filters

  function renderStatusFilter() {
    const group = document.getElementById('status-filter');
    const counts = {};
    for (const t of tests) counts[t.result.status] = (counts[t.result.status] || 0) + 1;
    const options = [['', 'All', tests.length]].concat(
      Object.keys(STATUS_ORDER)
        .filter((s) => counts[s])
        .map((s) => [s, STATUS_LABEL[s], counts[s]]),
    );
    for (const [value, label, count] of options) {
      const button = el(
        'button',
        { type: 'button', 'aria-pressed': String(value === filters.status) },
        [label, el('span', { className: 'count', text: count })],
      );
      button.addEventListener('click', () => {
        filters.status = value;
        for (const b of group.querySelectorAll('button'))
          b.setAttribute('aria-pressed', String(b === button));
        applyFilters();
      });
      group.append(button);
    }
  }

  function renderPersonaFilter() {
    const personas = [...new Set(tests.map((t) => t.plan.persona))].sort();
    const select = document.getElementById('filter-persona');
    if (personas.length < 2) {
      document.getElementById('persona-wrap').hidden = true;
      return;
    }
    select.append(el('option', { value: '', text: 'All personas' }));
    for (const p of personas) select.append(el('option', { value: p, text: p }));
    select.addEventListener('change', () => {
      filters.persona = select.value;
      applyFilters();
    });
  }

  function applyFilters() {
    let visible = 0;
    for (const card of document.querySelectorAll('.test')) {
      const show =
        (!filters.status || card.dataset.status === filters.status) &&
        (!filters.persona || card.dataset.persona === filters.persona);
      card.hidden = !show;
      if (show) visible++;
    }
    document.getElementById('empty').hidden = visible > 0;
  }

  // Selection and export

  function setChecked(testId, checked) {
    const box = document.querySelector(`input[data-test-id="${CSS.escape(testId)}"]`);
    if (box && box.checked !== checked) {
      box.checked = checked;
      box.dispatchEvent(new Event('change'));
    }
  }

  function updateFooter() {
    const n = selected.size;
    document.getElementById('selected-count').textContent =
      n === 0 ? 'No tests selected' : `${n} test${n === 1 ? '' : 's'} selected`;
    document.getElementById('export').disabled = n === 0;
    document.getElementById('select-none').hidden = n === 0;
  }

  function selectionIds() {
    // Plan order, so exported files are predictable.
    return results.tests.map((t) => t.test_id).filter((id) => selected.has(id));
  }

  function showDialog(title, body, text) {
    document.getElementById('dialog-title').textContent = title;
    document.getElementById('dialog-body').textContent = body;
    const area = document.getElementById('dialog-text');
    const copy = document.getElementById('dialog-copy');
    area.hidden = copy.hidden = text === undefined;
    area.value = text || '';
    document.getElementById('dialog').showModal();
  }

  async function exportToServer() {
    const button = document.getElementById('export');
    button.disabled = true;
    try {
      const response = await fetch('selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_test_ids: selectionIds() }),
      });
      const reply = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(reply.error || `HTTP ${response.status}`);
      showDialog(
        'Sent to Tessa',
        `${selected.size} test(s) sent. Go back to your editor; you can close this tab.`,
      );
    } catch (error) {
      showDialog('Could not send the selection', String(error.message || error));
    } finally {
      updateFooter();
    }
  }

  function exportStatic() {
    const selection = {
      version: 1,
      run_id: results.run_id,
      selected_test_ids: selectionIds(),
      created_at: new Date().toISOString(),
      source: 'static',
    };
    const text = JSON.stringify(selection, null, 2);
    const link = el('a', {
      href: URL.createObjectURL(new Blob([`${text}\n`], { type: 'application/json' })),
      download: 'selection.json',
    });
    document.body.append(link);
    link.click();
    link.remove();
    showDialog(
      'Selection saved',
      `This report was opened from disk, so it cannot reach Tessa directly. Move the downloaded selection.json into runs/${results.run_id}/ under your artifacts folder, or paste the text below into the chat with Tessa.`,
      text,
    );
  }

  // Lightbox

  function openLightbox(src, caption) {
    document.getElementById('lightbox-image').src = src;
    document.getElementById('lightbox-image').alt = caption;
    document.getElementById('lightbox-caption').textContent = caption;
    document.getElementById('lightbox').showModal();
  }

  // Wire up

  renderHeader();
  const list = document.getElementById('cards');
  for (const t of tests) list.append(testCard(t));
  renderStatusFilter();
  renderPersonaFilter();
  applyFilters();
  updateFooter();

  document.getElementById('select-passing').addEventListener('click', () => {
    for (const t of tests) if (t.result.status === 'passed') setChecked(t.result.test_id, true);
  });
  document.getElementById('select-none').addEventListener('click', () => {
    for (const t of tests) setChecked(t.result.test_id, false);
  });
  document.getElementById('export').addEventListener('click', () => {
    if (served) exportToServer();
    else exportStatic();
  });
  document
    .getElementById('dialog-close')
    .addEventListener('click', () => document.getElementById('dialog').close());
  document.getElementById('dialog-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText(document.getElementById('dialog-text').value);
  });
  const lightbox = document.getElementById('lightbox');
  document.getElementById('lightbox-close').addEventListener('click', () => lightbox.close());
  // Clicking the backdrop (the dialog element itself, outside its content) closes it.
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) lightbox.close();
  });
})();
