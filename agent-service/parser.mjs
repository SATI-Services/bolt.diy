// Action parser — extracts <boltArtifact> / <boltAction> tags from LLM response text.
// Simplified server-side port of bolt.diy's StreamingMessageParser (non-streaming mode).

const ARTIFACT_TAG_OPEN = '<boltArtifact';
const ARTIFACT_TAG_CLOSE = '</boltArtifact>';
const ACTION_TAG_OPEN = '<boltAction';
const ACTION_TAG_CLOSE = '</boltAction>';

/**
 * Parse a complete LLM response and extract all actions.
 * Returns an array of action objects:
 *   { type: 'file' | 'shell' | 'start' | 'build', content: string, filePath?: string }
 */
export function parseActions(responseText) {
  const actions = [];
  let i = 0;

  while (i < responseText.length) {
    // Find next artifact open
    const artifactStart = responseText.indexOf(ARTIFACT_TAG_OPEN, i);

    if (artifactStart === -1) {
      break;
    }

    const artifactTagEnd = responseText.indexOf('>', artifactStart);

    if (artifactTagEnd === -1) {
      break;
    }

    // Find artifact close
    const artifactCloseIndex = responseText.indexOf(ARTIFACT_TAG_CLOSE, artifactTagEnd);

    if (artifactCloseIndex === -1) {
      break;
    }

    // Extract artifact tag attributes
    const artifactTag = responseText.slice(artifactStart, artifactTagEnd + 1);
    const artifactTitle = extractAttribute(artifactTag, 'title');
    const artifactId = extractAttribute(artifactTag, 'id');

    // Parse actions within this artifact
    let actionSearchStart = artifactTagEnd + 1;

    while (actionSearchStart < artifactCloseIndex) {
      const actionStart = responseText.indexOf(ACTION_TAG_OPEN, actionSearchStart);

      if (actionStart === -1 || actionStart >= artifactCloseIndex) {
        break;
      }

      const actionTagEnd = responseText.indexOf('>', actionStart);

      if (actionTagEnd === -1 || actionTagEnd >= artifactCloseIndex) {
        break;
      }

      const actionClose = responseText.indexOf(ACTION_TAG_CLOSE, actionTagEnd);

      if (actionClose === -1 || actionClose > artifactCloseIndex) {
        break;
      }

      // Parse action tag
      const actionTag = responseText.slice(actionStart, actionTagEnd + 1);
      const actionType = extractAttribute(actionTag, 'type');
      let actionContent = responseText.slice(actionTagEnd + 1, actionClose).trim();

      const action = {
        type: actionType,
        content: actionContent,
        artifactId: artifactId || undefined,
        artifactTitle: artifactTitle || undefined,
      };

      if (actionType === 'file') {
        const filePath = extractAttribute(actionTag, 'filePath');
        action.filePath = filePath;

        // Clean markdown code block syntax if present (and not a .md file)
        if (filePath && !filePath.endsWith('.md')) {
          action.content = cleanMarkdownSyntax(actionContent);
          action.content = cleanEscapedTags(action.content);
        }

        // Ensure trailing newline for files
        if (!action.content.endsWith('\n')) {
          action.content += '\n';
        }
      }

      actions.push(action);
      actionSearchStart = actionClose + ACTION_TAG_CLOSE.length;
    }

    i = artifactCloseIndex + ARTIFACT_TAG_CLOSE.length;
  }

  return actions;
}

/**
 * Extract the plain text (non-action) content from the response.
 * Useful for determining if the LLM responded with only conversational text (= done).
 */
export function extractPlainText(responseText) {
  let text = responseText;

  // Remove all artifact blocks
  let start;

  while ((start = text.indexOf(ARTIFACT_TAG_OPEN)) !== -1) {
    const end = text.indexOf(ARTIFACT_TAG_CLOSE, start);

    if (end === -1) {
      break;
    }

    text = text.slice(0, start) + text.slice(end + ARTIFACT_TAG_CLOSE.length);
  }

  return text.trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractAttribute(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return match ? match[1] : null;
}

function cleanMarkdownSyntax(content) {
  const codeBlockRegex = /^\s*```\w*\n([\s\S]*?)\n\s*```\s*$/;
  const match = content.match(codeBlockRegex);
  return match ? match[1] : content;
}

function cleanEscapedTags(content) {
  return content.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/**
 * Format execution results as XML for feeding back to the LLM.
 */
export function formatExecutionResults(results) {
  const parts = ['<execution_results>'];

  for (const r of results) {
    if (r.type === 'file') {
      parts.push(`<result type="file" status="${r.status}" path="${r.filePath}" />`);
    } else if (r.type === 'shell' || r.type === 'start') {
      const attrs = [`type="${r.type}"`, `status="${r.status}"`];

      if (r.exitCode !== undefined) {
        attrs.push(`exit_code="${r.exitCode}"`);
      }

      parts.push(`<result ${attrs.join(' ')}>`);
      parts.push(`<command>${escapeXml(r.command || r.content || '')}</command>`);

      if (r.output) {
        parts.push(`<output>${escapeXml(r.output)}</output>`);
      }

      parts.push('</result>');
    }
  }

  parts.push('</execution_results>');
  parts.push('');
  parts.push('Review the results above. Fix any errors, then continue with the next step.');

  return parts.join('\n');
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
