import { useEffect, useId, useMemo, useState } from 'react'
import {
  answerSelections,
  answerSummary,
  type UserQuestionAnswer,
  type UserQuestionItem,
  type UserQuestionRequest,
  type UserQuestionSelection,
} from '../user-question.ts'

function emptySelection(): UserQuestionSelection {
  return { selectedOptions: [], customResponse: '' }
}

function QuestionField({
  item,
  index,
  value,
  disabled,
  groupId,
  onChange,
}: {
  item: UserQuestionItem
  index: number
  value: UserQuestionSelection
  disabled: boolean
  groupId: string
  onChange: (value: UserQuestionSelection) => void
}) {
  function toggle(optionIndex: number) {
    if (item.multiSelect) {
      const selected = value.selectedOptions.includes(optionIndex)
        ? value.selectedOptions.filter((current) => current !== optionIndex)
        : [...value.selectedOptions, optionIndex]
      onChange({ ...value, selectedOptions: selected })
      return
    }
    onChange({ ...value, selectedOptions: [optionIndex] })
  }

  return (
    <fieldset className="agent-question-field" disabled={disabled}>
      <legend>{item.question}</legend>
      {item.options.length ? (
        <div className="agent-question-options">
          {item.options.map((option, optionIndex) => {
            const checked = value.selectedOptions.includes(optionIndex)
            return (
              <label key={`${option.label}-${optionIndex}`} className={`agent-question-option${checked ? ' is-selected' : ''}`}>
                <input
                  type={item.multiSelect ? 'checkbox' : 'radio'}
                  name={`${groupId}-${index}`}
                  checked={checked}
                  onChange={() => toggle(optionIndex)}
                />
                <span>
                  <strong>{option.label}</strong>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
              </label>
            )
          })}
        </div>
      ) : null}
      <label className="agent-question-custom">
        <span>{item.options.length ? '其他补充（可选）' : '请输入回答'}</span>
        <textarea
          rows={2}
          value={value.customResponse ?? ''}
          placeholder={item.options.length ? '如果以上选项都不合适，可以直接说明' : '输入你的回答'}
          onChange={(event) => onChange({ ...value, customResponse: event.target.value })}
        />
      </label>
    </fieldset>
  )
}

export function UserQuestion({
  promptId,
  request,
  answered,
  onAnswer,
}: {
  promptId: string
  request: UserQuestionRequest
  answered?: UserQuestionAnswer
  onAnswer: (promptId: string, answer: UserQuestionAnswer) => Promise<void>
}) {
  const id = useId()
  const [selections, setSelections] = useState<UserQuestionSelection[]>(
    () => request.questions.map(emptySelection),
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setSelections(request.questions.map(emptySelection))
    setSubmitting(false)
    setError('')
  }, [request.actionId, request.messageId, request.questions])

  const complete = useMemo(
    () => selections.every(
      (selection) =>
        selection.selectedOptions.length > 0
        || !!selection.customResponse?.trim(),
    ),
    [selections],
  )

  if (answered) {
    const summaries = answerSummary(request, answered)
    return (
      <div className="agent-question is-answered">
        <div className="agent-question-status">已回答</div>
        {request.questions.map((item, index) => (
          <div className="agent-question-answer" key={`${item.question}-${index}`}>
            <span>{item.question}</span>
            <strong>{summaries[index] ?? '未选择'}</strong>
          </div>
        ))}
      </div>
    )
  }

  async function submit() {
    if (!complete || submitting) return
    const answer: UserQuestionAnswer = request.questions.length === 1
      ? selections[0]!
      : { answers: selections }
    setSubmitting(true)
    setError('')
    try {
      await onAnswer(promptId, answer)
    } catch {
      setError('回答没有送达，请重试。')
      setSubmitting(false)
    }
  }

  return (
    <form
      className="agent-question"
      aria-label="Agent 需要你的确认"
      onSubmit={(event) => { event.preventDefault(); void submit() }}
    >
      <div className="agent-question-head">
        <strong>{request.questions.length > 1 ? request.question : '需要确认一项信息'}</strong>
        <span>回答后继续处理</span>
      </div>
      {request.questions.map((item, index) => (
        <QuestionField
          key={`${item.question}-${index}`}
          item={item}
          index={index}
          value={selections[index] ?? emptySelection()}
          disabled={submitting}
          groupId={id}
          onChange={(selection) => setSelections((current) =>
            current.map((value, currentIndex) => currentIndex === index ? selection : value)
          )}
        />
      ))}
      <div className="agent-question-actions">
        {error ? <span className="agent-question-error" role="alert">{error}</span> : <span />}
        <button type="submit" disabled={!complete || submitting}>
          {submitting ? '正在提交…' : '提交回答'}
        </button>
      </div>
    </form>
  )
}
