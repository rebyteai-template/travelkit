export interface UserQuestionOption {
  label: string
  description?: string
}

export interface UserQuestionItem {
  question: string
  options: UserQuestionOption[]
  multiSelect: boolean
  input?: unknown
}

export interface UserQuestionRequest extends UserQuestionItem {
  actionId: string
  messageId: string
  questions: UserQuestionItem[]
}

export interface UserQuestionSelection {
  selectedOptions: number[]
  customResponse?: string
}

export type UserQuestionAnswer =
  | UserQuestionSelection
  | { answers: UserQuestionSelection[] }

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseOptions(value: unknown): UserQuestionOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((option) => {
    if (!isObject(option) || typeof option.label !== 'string' || !option.label.trim()) return []
    return [{
      label: option.label.trim(),
      ...(typeof option.description === 'string' && option.description.trim()
        ? { description: option.description.trim() }
        : {}),
    }]
  })
}

function parseItem(value: unknown): UserQuestionItem | null {
  if (!isObject(value) || typeof value.question !== 'string' || !value.question.trim()) return null
  return {
    question: value.question.trim(),
    options: parseOptions(value.options),
    multiSelect: value.multiSelect === true,
    ...(value.input !== undefined ? { input: value.input } : {}),
  }
}

/** Normalize the relay's public ask_user_question event into the durable shape
 * shared by TaskDO and the browser. Returns null for malformed events so an
 * untrusted payload can never park a turn with no answerable question. */
export function parseUserQuestionRequest(value: unknown): UserQuestionRequest | null {
  if (!isObject(value)) return null
  const actionId = typeof value.actionId === 'string' || typeof value.actionId === 'number'
    ? String(value.actionId).trim()
    : ''
  const messageId = typeof value.messageId === 'string' ? value.messageId.trim() : ''
  const topLevel = parseItem(value)
  if (!actionId || !messageId || !topLevel) return null

  const batched = Array.isArray(value.questions)
    ? value.questions.map(parseItem).filter((item): item is UserQuestionItem => item !== null)
    : []

  return {
    actionId,
    messageId,
    ...topLevel,
    questions: batched.length ? batched : [topLevel],
  }
}

export function isUserQuestionAnswer(value: unknown): value is UserQuestionAnswer {
  if (!isObject(value)) return false
  if (Array.isArray(value.answers)) return value.answers.every(isSelection)
  return isSelection(value)
}

function isSelection(value: unknown): value is UserQuestionSelection {
  if (!isObject(value) || !Array.isArray(value.selectedOptions)) return false
  if (!value.selectedOptions.every((index) => Number.isInteger(index) && index >= 0)) return false
  return value.customResponse === undefined || typeof value.customResponse === 'string'
}

export function answerSelections(
  request: UserQuestionRequest,
  answer: UserQuestionAnswer,
): UserQuestionSelection[] {
  if ('answers' in answer) return answer.answers
  return [answer]
}

export function answerSummary(
  request: UserQuestionRequest,
  answer: UserQuestionAnswer,
): string[] {
  return answerSelections(request, answer).map((selection, index) => {
    const item = request.questions[index] ?? request
    const labels = selection.selectedOptions
      .map((optionIndex) => item.options[optionIndex]?.label)
      .filter((label): label is string => !!label)
    if (selection.customResponse?.trim()) labels.push(selection.customResponse.trim())
    return labels.join('、') || '未选择'
  })
}
