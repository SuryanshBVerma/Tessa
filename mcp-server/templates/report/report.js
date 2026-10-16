// Tessa report page. Built entirely with DOM APIs (createElement, textContent): nothing from the
// results, which include text read from the app under test, is ever parsed as HTML.
(() => {
  'use strict';

  const data = JSON.parse(document.getElementById('tessa-data').textContent);
  const results = data.results;
  const planById = new Map(data.tests.map((t) => [t.id, t]));
  const selected = new Set();
  // Served by tessa-mcp at http://127.0.0.1:<port>/<token>/; opened from disk otherwise.
  const served = location.protocol === 'http:' && location.hostname === '127.0.0.1';

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'className') node.className = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children || []) {
      if (child !== null && child !== undefined) node.append(child);
    }
    return node;
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
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  function describeTarget(step) {
    const t = step.target;
    if (!t) return '';
    if (t.strategy === 'role') return `role=${t.role}${t.name ? ` "${t.name}"` : ''}`;
    return `${t.strategy}="${t.value}"`;
  }

  function describeStep(step) {
    const parts = [step.action];
    const target = describeTarget(step);
    if (target) parts.push(target);
    if (step.value !== undefined) parts.push(`value "${step.value}"`);
    if (step.value_env) parts.push(`value from $${step.value_env}`);
    if (step.assertion) {
      const a = step.assertion;
      parts.push(a.expected === undefined ? a.kind : `${a.kind} ${JSON.stringify(a.expected)}`);
    }
    return parts.join(' · ');
  }

  function formatValue(value) {
    if (Array.isArray(value)) return value.join(', ') || '—';
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join(', ') : '—';
    }
    return value === undefined || value === '' ? '—' : String(value);
  }

  function header() {
    document.getElementById('story-title').textContent = data.story.title;
    const env = results.environment;
    const bits = [
      `Run ${results.run_id}`,
      `story ${results.story_id}`,
      env.branch ? `branch ${env.branch}` : null,
      env.commit
        ? `commit ${env.commit.slice(0, 7)}${env.dirty ? ' (uncommitted changes)' : ''}`
        : null,
      `host ${env.host}`,
      `finished ${new Date(results.finished_at).toLocaleString()}`,
    ].filter(Boolean);
    document.getElementById('run-meta').textContent = bits.join(' · ');
    const summary = document.getElementById('summary');
    for (const key of ['total', 'passed', 'failed', 'error', 'skipped']) {
      summary.append(
        el('div', {}, [
          el('dt', { text: key }),
          el('dd', {
            text: results.summary[key],
            className: key === 'total' ? '' : `status-${key}`,
          }),
        ]),
      );
    }
    document.getElementById('export-target').textContent = `Export target: ${data.options.target}`;
  }

  function envSection(envState) {
    const rows = [
      ['Persona', envState.persona],
      ['Role', envState.role],
      ['Permissions', envState.permissions],
      ['Settings', envState.settings],
      ['Feature flags', envState.feature_flags],
      ['Seed profile', envState.seed_profile],
      ['Build', envState.build],
    ];
    return el(
      'dl',
      { className: 'env' },
      rows.flatMap(([label, value]) => [
        el('dt', { text: label }),
        el('dd', { text: formatValue(value) }),
      ]),
    );
  }

  function flowSection(test, plan) {
    const byIndex = new Map(test.steps.map((s) => [s.index, s]));
    const failedIndex = test.failure ? test.failure.step_index : -1;
    const items = plan.steps.map((step, index) => {
      const record = byIndex.get(index);
      const status = record ? record.status : 'not run';
      const image = record && safeImage(record.screenshot);
      return el('li', { className: `step${index === failedIndex ? ' is-failed' : ''}` }, [
        el('span', { className: 'step-index', text: index + 1 }),
        el('div', {}, [
          el('span', { text: step.description }),
          el('span', { className: `pill status-${record ? status : 'skipped'}`, text: status }),
          el('span', { className: 'step-detail', text: describeStep(step) }),
          record && record.selector_used
            ? el('span', { className: 'step-detail', text: `resolved as ${record.selector_used}` })
            : null,
        ]),
        image
          ? el('a', { className: 'thumb', href: image, target: '_blank', rel: 'noopener' }, [
              el('img', { src: image, alt: `Screenshot after step ${index + 1}`, loading: 'lazy' }),
            ])
          : el('span'),
      ]);
    });
    return el('ol', { className: 'flow' }, items);
  }

  function failureSection(test, plan) {
    const f = test.failure;
    if (!f) return null;
    const step = plan.steps[f.step_index];
    const image = safeImage(f.screenshot);
    return el('div', { className: 'failure' }, [
      el('h3', {
        className: 'section-title',
        text: `Failed at step ${f.step_index + 1}${step ? `: ${step.description}` : ''}`,
      }),
      el('p', { text: f.message }),
      f.expected || f.actual
        ? el('div', { className: 'compare' }, [
            el('div', {}, [
              el('strong', { text: 'Expected' }),
              el('p', { text: f.expected || '—' }),
            ]),
            el('div', {}, [el('strong', { text: 'Actual' }), el('p', { text: f.actual || '—' })]),
          ])
        : null,
      image
        ? el('img', { src: image, alt: `Screenshot of the failing step ${f.step_index + 1}` })
        : null,
    ]);
  }

  function signalsSection(test) {
    const q = test.quality || {};
    const rows = [
      ['Selector stability', q.selector_stability],
      [
        'Rerun consistency',
        q.rerun_consistency === undefined ? undefined : `${Math.round(q.rerun_consistency * 100)}%`,
      ],
      ['Attempts', test.attempts],
    ];
    if (data.options.show_overlap) {
      rows.push([
        'Overlaps with',
        q.overlap_with && q.overlap_with.length ? q.overlap_with.join(', ') : 'none',
      ]);
    }
    if (test.triage) {
      rows.push([
        'Triage',
        `${test.triage.class} (${test.triage.confidence}): ${test.triage.rationale}`,
      ]);
    }
    return el(
      'dl',
      { className: 'signals' },
      rows
        .filter(([, v]) => v !== undefined)
        .map(([label, value]) =>
          el('div', {}, [el('dt', { text: label }), el('dd', { text: value })]),
        ),
    );
  }

  function card(test) {
    const plan = planById.get(test.test_id);
    if (!plan) return null;
    const checkbox = el('input', {
      type: 'checkbox',
      'aria-label': `Select ${plan.name}`,
      'data-test-id': test.test_id,
    });
    const node = el(
      'article',
      {
        className: 'card',
        'data-status': test.status,
        'data-persona': plan.persona,
        'data-story': results.story_id,
        'aria-labelledby': `title-${test.test_id}`,
      },
      [
        el('div', { className: 'card-head' }, [
          checkbox,
          el('div', { className: 'card-title' }, [
            el('h2', { id: `title-${test.test_id}`, text: plan.name }),
            el('span', { className: 'card-ids', text: `${test.test_id} · ${results.story_id}` }),
          ]),
          el('div', {}, [
            el('span', { className: `pill status-${test.status}`, text: test.status }),
            el('span', { className: 'duration', text: formatMs(test.duration_ms) }),
          ]),
        ]),
        el('p', { className: 'intent', text: plan.intent }),
        el('h3', { className: 'section-title', text: 'Environment' }),
        envSection(test.env_state),
        el('h3', { className: 'section-title', text: 'Flow' }),
        flowSection(test, plan),
        failureSection(test, plan),
        el('h3', { className: 'section-title', text: 'Quality signals' }),
        signalsSection(test),
        data.options.show_code_preview
          ? el('details', {}, [
              el('summary', { text: `Code preview (${data.options.target})` }),
              el('p', {
                className: 'meta',
                text: 'Exported code appears here once an emitter exists for this target. Until then, this is the test as Tessa stores it.',
              }),
              el('pre', {}, [el('code', { text: JSON.stringify(plan, null, 2) })]),
            ])
          : null,
      ],
    );
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(test.test_id);
      else selected.delete(test.test_id);
      node.classList.toggle('is-selected', checkbox.checked);
      updateFooter();
    });
    return node;
  }

  function fillSelect(id, label, values) {
    const select = document.getElementById(id);
    select.append(el('option', { value: '', text: `All ${label}` }));
    for (const value of [...new Set(values)].sort()) {
      select.append(el('option', { value, text: value }));
    }
    select.addEventListener('change', applyFilters);
  }

  function applyFilters() {
    const status = document.getElementById('filter-status').value;
    const persona = document.getElementById('filter-persona').value;
    const story = document.getElementById('filter-story').value;
    let visible = 0;
    for (const node of document.querySelectorAll('.card')) {
      const show =
        (!status || node.dataset.status === status) &&
        (!persona || node.dataset.persona === persona) &&
        (!story || node.dataset.story === story);
      node.hidden = !show;
      if (show) visible++;
    }
    document.getElementById('visible-count').textContent =
      `${visible} of ${results.tests.length} shown`;
  }

  function setChecked(testId, checked) {
    const box = document.querySelector(`input[data-test-id="${CSS.escape(testId)}"]`);
    if (box && box.checked !== checked) {
      box.checked = checked;
      box.dispatchEvent(new Event('change'));
    }
  }

  function updateFooter() {
    document.getElementById('selected-count').textContent = `${selected.size} selected`;
    document.getElementById('export').disabled = selected.size === 0;
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

  function selectionIds() {
    // Keep plan order so the exported files are predictable.
    return results.tests.map((t) => t.test_id).filter((id) => selected.has(id));
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

  header();
  const cards = document.getElementById('cards');
  for (const test of results.tests) {
    const node = card(test);
    if (node) cards.append(node);
  }
  fillSelect(
    'filter-status',
    'statuses',
    results.tests.map((t) => t.status),
  );
  fillSelect(
    'filter-persona',
    'personas',
    results.tests.map((t) => planById.get(t.test_id)?.persona).filter(Boolean),
  );
  fillSelect('filter-story', 'stories', [results.story_id]);
  applyFilters();
  updateFooter();

  document.getElementById('select-passing').addEventListener('click', () => {
    for (const t of results.tests) if (t.status === 'passed') setChecked(t.test_id, true);
  });
  document.getElementById('select-none').addEventListener('click', () => {
    for (const t of results.tests) setChecked(t.test_id, false);
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
})();
