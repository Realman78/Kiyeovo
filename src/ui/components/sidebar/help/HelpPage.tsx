import { useMemo, useState, type FC } from 'react';
import {
  ChevronDown,
  CircleHelp,
  Search,
  X,
} from 'lucide-react';
import { Input } from '../../ui/Input';
import { HELP_QUESTIONS, helpQuestionMatches, normalizeHelpQuery } from './helpQuestions';

const ALL_CATEGORIES = 'All';

export const HelpPage: FC = () => {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(ALL_CATEGORIES);
  const [openQuestionIds, setOpenQuestionIds] = useState<Set<string>>(() => new Set());

  const categories = useMemo(
    () => [
      ALL_CATEGORIES,
      ...HELP_QUESTIONS.reduce<string[]>((result, question) => {
        if (!result.includes(question.category)) {
          result.push(question.category);
        }
        return result;
      }, []),
    ],
    [],
  );

  const normalizedQuery = normalizeHelpQuery(query);
  const filteredQuestions = useMemo(
    () => HELP_QUESTIONS.filter((question) => (
      (activeCategory === ALL_CATEGORIES || question.category === activeCategory)
      && helpQuestionMatches(question, normalizedQuery)
    )),
    [activeCategory, normalizedQuery],
  );

  const toggleQuestion = (id: string) => {
    setOpenQuestionIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const clearSearch = () => {
    setQuery('');
  };

  const clearFilters = () => {
    setQuery('');
    setActiveCategory(ALL_CATEGORIES);
  };

  return (
    <div className="h-full overflow-y-auto bg-background py-8">
      <div className="mx-auto w-full max-w-4xl px-8 pt-10">
        <header className="flex flex-col">
          <div className='flex flex-col gap-2'>
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
                <CircleHelp className="h-5 w-5" />
              </div>
              <h1 className="min-w-0 text-2xl font-semibold text-foreground">
                Questions &amp; Answers
              </h1>
            </div>
            <p className="text-left text-sm text-muted-foreground">
              Answers for parts of Kiyeovo that are easiest to misunderstand.
            </p>
          </div>
        </header>

        <div className="z-20 -mx-8 border-b border-border/70 bg-background/95 px-8 py-4 backdrop-blur">
          <div className="relative">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search questions"
              aria-label="Search questions"
              icon={<Search className="h-4 w-4" />}
              className={query ? 'pr-11' : undefined}
            />
            {query && (
              <button
                type="button"
                onClick={clearSearch}
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                aria-label="Clear search"
                title="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {categories.map((category) => {
              const active = category === activeCategory;
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => setActiveCategory(category)}
                  aria-pressed={active}
                  className={`h-8 cursor-pointer rounded-sm border px-3 text-xs font-medium uppercase transition-colors ${
                    active
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'border-primary/40 bg-transparent text-primary/80 hover:border-primary hover:bg-primary/10 hover:text-primary'
                  }`}
                >
                  {category}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-6 space-y-3">
          {filteredQuestions.map((question) => {
            const isOpen = openQuestionIds.has(question.id);
            const Icon = question.icon;

            return (
              <section
                key={question.id}
                className="rounded-lg border border-border bg-background/60 outline-0"
              >
                <button
                  type="button"
                  onClick={() => toggleQuestion(question.id)}
                  className="flex w-full cursor-pointer items-start outline-0 justify-between gap-4 p-4 text-left transition-colors hover:bg-secondary/40"
                  aria-expanded={isOpen}
                >
                  <span className="flex min-w-0 gap-3">
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0">
                      <span className="text-xs font-medium uppercase text-primary">
                        {question.category}
                      </span>
                      <span className="mt-1 block text-sm font-medium text-foreground">
                        {question.question}
                      </span>
                      <span className="mt-1 block text-sm text-muted-foreground">
                        {question.summary}
                      </span>
                    </span>
                  </span>
                  <ChevronDown
                    className={`mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''
                      }`}
                  />
                </button>

                {isOpen && (
                  <div className="border-t border-border px-4 pb-4 pt-3">
                    <div className="space-y-2 pl-12 text-sm text-justify leading-6 text-muted-foreground">
                      {question.answer.map((paragraph) => (
                        <p key={paragraph}>{paragraph}</p>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            );
          })}

          {filteredQuestions.length === 0 && (
            <div className="rounded-lg border border-border bg-background/60 p-8 text-center">
              <CircleHelp className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium text-foreground">No matching questions</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Try a shorter search, or switch to another category.
              </p>
              {(query || activeCategory !== ALL_CATEGORIES) && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="mt-4 h-8 cursor-pointer rounded-sm border border-primary/40 px-3 text-xs font-medium uppercase text-primary/80 transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary"
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
