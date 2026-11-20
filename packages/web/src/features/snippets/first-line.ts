/** First non-blank line of a snippet's body: what lists show beside its name. */
export function firstLine(body: string): string {
  return (
    body
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  );
}
