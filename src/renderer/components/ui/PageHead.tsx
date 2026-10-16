import type { ReactElement, ReactNode } from "react";

type PageHeadProps = Readonly<{
  actions?: ReactNode;
  badges?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  title: ReactNode;
}>;

export function PageHead({ actions, badges, description, meta, title }: PageHeadProps): ReactElement {
  return (
    <header className="ui-page-head">
      <div className="ui-page-head__copy">
        <div className="ui-page-head__title-row">
          <h1>{title}</h1>
          {badges}
        </div>
        {description ? <p>{description}</p> : null}
        {meta ? <div className="ui-page-head__meta">{meta}</div> : null}
      </div>
      {actions ? <div className="ui-page-head__actions">{actions}</div> : null}
    </header>
  );
}
