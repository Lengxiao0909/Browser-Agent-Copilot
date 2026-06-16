import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolPlan } from '../dist/modules/chat/tool-planner.js';

function createRequest(message, contextOverrides = {}) {
  return {
    message,
    scope: 'visible-page',
    context: {
      title: 'Example page',
      url: 'https://example.test/',
      visibleText: 'Alpha Beta Gamma',
      links: [],
      headings: [],
      landmarks: [],
      ...contextOverrides
    }
  };
}

function planToolNames(message, contextOverrides) {
  return createToolPlan(createRequest(message, contextOverrides)).toolCalls.map((call) => call.toolName);
}

test('plans link extraction for Chinese and English link intents', () => {
  assert.deepEqual(planToolNames('提取当前页面所有链接'), ['browser.extract_links']);
  assert.deepEqual(planToolNames('Extract page links'), ['browser.extract_links']);
});

test('plans structure and selected text tools when requested', () => {
  const names = planToolNames('分析当前页面结构和选中内容', {
    selection: {
      text: 'Selected content',
      pageUrl: 'https://example.test/',
      pageTitle: 'Example page'
    }
  });

  assert.deepEqual(names, [
    'browser.describe_page_structure',
    'browser.read_selected_text'
  ]);
});

test('does not plan browser tools for ordinary page summaries', () => {
  assert.deepEqual(planToolNames('请总结当前页面'), []);
  assert.deepEqual(planToolNames('分析当前页面的主题和结构'), ['browser.describe_page_structure']);
});

test('plans web search for research and literature tasks', () => {
  const plan = createToolPlan(createRequest('总结查找某研究方向（如室内定位）的最有价值性阅读的5篇综述文献')).toolCalls[0];
  assert.equal(plan.toolName, 'browser.search_web');
  assert.equal(plan.risk, 'medium');
  assert.equal(plan.input.engine, 'scholar');
  assert.equal(plan.input.readTopResults, true);
  assert.equal(plan.input.maxPages, 5);
  assert.match(plan.input.query, /室内定位/);
});

test('does not plan selected text tool when no selection exists', () => {
  assert.deepEqual(planToolNames('解释选中内容'), []);
});

test('extracts quoted query for find, highlight, and scroll intents', () => {
  const findPlan = createToolPlan(createRequest('查找“Alpha Beta”')).toolCalls[0];
  assert.equal(findPlan.toolName, 'browser.find_text');
  assert.deepEqual(findPlan.input, { query: 'Alpha Beta', maxMatches: 8 });

  const highlightPlan = createToolPlan(createRequest('请高亮 "Gamma"')).toolCalls[0];
  assert.equal(highlightPlan.toolName, 'browser.highlight_text');
  assert.deepEqual(highlightPlan.input, { query: 'Gamma', maxMatches: 8 });

  const scrollPlan = createToolPlan(createRequest('scroll to `Beta`')).toolCalls[0];
  assert.equal(scrollPlan.toolName, 'browser.scroll_to_text');
  assert.deepEqual(scrollPlan.input, { query: 'Beta' });
});

test('prioritizes highlight over scroll and find text actions', () => {
  const names = planToolNames('查找 Beta，然后高亮 Beta，并滚动到 Beta');
  assert.deepEqual(names, ['browser.highlight_text']);
});
