export function promptText(title: string, placeholderText: string): Promise<string | null> {
  return new Promise((resolve) => wx.showModal({
    title, editable: true, placeholderText,
    success: (result) => resolve(result.confirm ? (result.content || "").trim() : null),
    fail: () => resolve(null),
  }));
}

export function confirmAction(title: string, content: string): Promise<boolean> {
  return new Promise((resolve) => wx.showModal({
    title, content, success: (result) => resolve(result.confirm), fail: () => resolve(false),
  }));
}
