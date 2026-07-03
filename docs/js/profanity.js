// Basic automod — extend this list as needed
const BLOCKED = [
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'kike', 'chink',
  'cunt', 'rape', 'nazi', 'hitler',
];

export function containsProfanity(...texts) {
  const haystack = texts.filter(Boolean).join(' ').toLowerCase();
  return BLOCKED.some((word) => {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(haystack);
  });
}

export function profanityMessage() {
  return 'Your edit contains language that isn\'t allowed on Hacknet. Please revise and try again.';
}
