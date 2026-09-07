import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function FormattedMarkdown(props: React.ComponentProps<typeof Markdown>) {
  return <Markdown {...props} remarkPlugins={[remarkGfm]} />;
}
