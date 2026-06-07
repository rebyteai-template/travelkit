import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  // 链接新开标签页;本流程里支付/第三方链接很常见
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // 复用现有的横向滚动包裹(移动端票价表已经在用)
  table: ({ children }) => (
    <div className="table-scroll">
      <table>{children}</table>
    </div>
  ),
}

/** 把助手消息文本按 Markdown 渲染(GFM:表格/删除线/任务列表/自动成链)。
 *  不启用 rehype-raw → 模型输出里的裸 HTML 不渲染,默认防 XSS。 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
