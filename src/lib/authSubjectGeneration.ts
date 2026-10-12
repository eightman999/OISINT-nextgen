/** Inert identity epoch: importing this module does not initialize Supabase. */
let subjectKey: string | null | undefined;
let generation = 0;

/** Called synchronously by the singleton auth observer, including between renders. */
export function observeAuthSubject(user: { id: string; is_anonymous?: boolean } | null): void {
  const nextKey = user ? JSON.stringify([user.id, user.is_anonymous === true]) : null;
  if (nextKey !== subjectKey) {
    subjectKey = nextKey;
    generation += 1;
  }
}

export function getAuthSubjectGeneration(): number {
  return generation;
}
