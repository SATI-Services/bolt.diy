/**
 * Cleans preview container URLs from stack traces to show relative paths instead
 */
export function cleanStackTrace(stackTrace: string): string {
  // Function to clean a single URL
  const cleanUrl = (url: string): string => {
    const regex = /^https?:\/\/[^\/]+\.bolt\.rdrt\.org(\/.*)?$/;

    if (!regex.test(url)) {
      return url;
    }

    const pathRegex = /^https?:\/\/[^\/]+\.bolt\.rdrt\.org\/(.*?)$/;
    const match = url.match(pathRegex);

    return match?.[1] || '';
  };

  // Split the stack trace into lines and process each line
  return stackTrace
    .split('\n')
    .map((line) => {
      // Match any URL in the line that contains bolt.rdrt.org
      return line.replace(/(https?:\/\/[^\/]+\.bolt\.rdrt\.org\/[^\s\)]+)/g, (match) => cleanUrl(match));
    })
    .join('\n');
}
