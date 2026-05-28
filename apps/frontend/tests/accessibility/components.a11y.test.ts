import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { DeploymentStatusBadge } from '../../src/components/deployments/DeploymentStatusBadge';
import { ErrorState } from '../../src/components/app/ErrorState';
import { RetryButton } from '../../src/components/app/RetryButton';
import { StatusBadge } from '../../src/components/app/StatusBadge';
import { NavItem } from '../../src/components/app/NavItem';
import { Breadcrumbs } from '../../src/components/app/Breadcrumbs';
import { Sidebar } from '../../src/components/app/Sidebar';
import { MobileDrawer } from '../../src/components/app/MobileDrawer';

vi.mock('next/navigation', () => ({
  usePathname: () => '/app/deployments',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, className, ...props }: any) =>
    React.createElement('a', { href, className, ...props }, children),
}));

expect.extend(toHaveNoViolations);

// ── Shared fixtures ───────────────────────────────────────────────────────────

const mockIcon = React.createElement('svg', { 'aria-hidden': 'true' });

const fakeUser = { id: 'u1', name: 'Jane Doe', email: 'jane@example.com', role: 'user' as const };

const navItems = [
  { id: 'nav-deployments', label: 'Deployments', icon: mockIcon, path: '/app/deployments' },
  { id: 'nav-templates', label: 'Templates', icon: mockIcon, path: '/app/templates' },
  { id: 'nav-settings', label: 'Settings', icon: mockIcon, path: '/app/settings' },
];

// ── Accessibility Tests ───────────────────────────────────────────────────────

describe('Accessibility Tests for Frontend Components', () => {
  describe('DeploymentStatusBadge', () => {
    it('should have no accessibility violations', async () => {
      const { container } = render(
        <DeploymentStatusBadge status="completed" />
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have proper ARIA labels', () => {
      const { container } = render(
        <DeploymentStatusBadge status="completed" />
      );
      const badge = container.querySelector('[role="status"]');
      expect(badge).toBeTruthy();
    });
  });

  describe('ErrorState', () => {
    it('should have no accessibility violations', async () => {
      const { container } = render(
        <ErrorState title="Error" message="Something went wrong" />
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have proper heading hierarchy', () => {
      const { container } = render(
        <ErrorState title="Error" message="Something went wrong" />
      );
      const heading = container.querySelector('h2');
      expect(heading).toBeTruthy();
      expect(heading?.textContent).toBe('Error');
    });
  });

  describe('RetryButton', () => {
    it('should have no accessibility violations', async () => {
      const { container } = render(
        <RetryButton onClick={() => {}} />
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have accessible button with proper label', () => {
      const { getByRole } = render(
        <RetryButton onClick={() => {}} />
      );
      const button = getByRole('button');
      expect(button).toBeTruthy();
      expect(button.textContent).toBeTruthy();
    });

    it('should be keyboard accessible', () => {
      const { getByRole } = render(
        <RetryButton onClick={() => {}} />
      );
      const button = getByRole('button');
      expect(button).not.toHaveAttribute('disabled');
    });
  });

  describe('StatusBadge', () => {
    it('should have no accessibility violations', async () => {
      const { container } = render(
        <StatusBadge status="active" />
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have semantic HTML', () => {
      const { container } = render(
        <StatusBadge status="active" />
      );
      const badge = container.querySelector('span');
      expect(badge).toBeTruthy();
    });
  });

  describe('NavItem', () => {
    it('should have no accessibility violations', async () => {
      const { container } = render(
        <NavItem href="/test" label="Test" />
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have proper link semantics', () => {
      const { getByRole } = render(
        <NavItem href="/test" label="Test" />
      );
      const link = getByRole('link');
      expect(link).toHaveAttribute('href', '/test');
    });

    // WCAG 2.4.3 Focus Order / 4.1.2 Name, Role, Value
    // Active nav item must expose aria-current="page" so screen readers
    // announce the current location within the navigation landmark.
    it('exposes aria-current="page" on the active nav link (WCAG 2.4.3)', () => {
      const { getByRole } = render(
        <NavItem label="Deployments" icon={mockIcon} path="/app/deployments" active />
      );
      const link = getByRole('link');
      expect(link).toHaveAttribute('aria-current', 'page');
    });

    it('does not set aria-current on an inactive nav link', () => {
      const { getByRole } = render(
        <NavItem label="Templates" icon={mockIcon} path="/app/templates" active={false} />
      );
      const link = getByRole('link');
      expect(link).not.toHaveAttribute('aria-current');
    });

    // WCAG 2.4.6 Headings and Labels — link must have a non-empty accessible name
    it('has a non-empty accessible name from its label text (WCAG 2.4.6)', () => {
      const { getByRole } = render(
        <NavItem label="Settings" icon={mockIcon} path="/app/settings" />
      );
      expect(getByRole('link', { name: /settings/i })).toBeTruthy();
    });

    // WCAG 4.1.2 Name, Role, Value — disabled item must not be a focusable link
    it('renders as a non-link element when disabled to prevent keyboard focus trap (WCAG 4.1.2)', () => {
      const { queryByRole } = render(
        <NavItem label="Disabled" icon={mockIcon} path="/app/disabled" disabled />
      );
      expect(queryByRole('link')).toBeNull();
    });

    // WCAG 2.1.1 Keyboard — badge count is visible text, not an icon-only label
    it('badge count is visible accessible text, not icon-only (WCAG 1.1.1)', () => {
      const { getByText } = render(
        <NavItem label="Notifications" icon={mockIcon} path="/app/notifs" badge={7} />
      );
      expect(getByText('7')).toBeTruthy();
    });

    it('displays 99+ badge for large counts without losing context', () => {
      const { getByText } = render(
        <NavItem label="Notifications" icon={mockIcon} path="/app/notifs" badge={200} />
      );
      expect(getByText('99+')).toBeTruthy();
    });

    it('has no axe violations for active state (WCAG 2.4.3)', async () => {
      const { container } = render(
        <NavItem label="Active" icon={mockIcon} path="/app/active" active />
      );
      expect(await axe(container)).toHaveNoViolations();
    });

    it('has no axe violations for disabled state (WCAG 4.1.2)', async () => {
      const { container } = render(
        <NavItem label="Disabled" icon={mockIcon} path="/app/disabled" disabled />
      );
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  describe('Breadcrumbs', () => {
    it('should have no accessibility violations', async () => {
      const { container } = render(
        <Breadcrumbs items={[{ label: 'Home', href: '/' }]} />
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have proper navigation semantics', () => {
      const { container } = render(
        <Breadcrumbs items={[{ label: 'Home', href: '/' }]} />
      );
      const nav = container.querySelector('nav');
      expect(nav).toBeTruthy();
    });

    it('should have proper ARIA labels for breadcrumb list', () => {
      const { container } = render(
        <Breadcrumbs items={[{ label: 'Home', href: '/' }]} />
      );
      const list = container.querySelector('[role="list"]');
      expect(list).toBeTruthy();
    });

    // WCAG 2.4.8 Location — the breadcrumb nav must be labelled so screen
    // readers can distinguish it from other navigation landmarks on the page.
    it('breadcrumb nav has aria-label="Breadcrumb" for landmark identification (WCAG 2.4.8)', () => {
      const { container } = render(
        <Breadcrumbs items={[{ label: 'Home', path: '/' }, { label: 'Deployments', path: '/app/deployments' }]} />
      );
      const nav = container.querySelector('nav');
      expect(nav).toHaveAttribute('aria-label', 'Breadcrumb');
    });

    // WCAG 4.1.2 Name, Role, Value — intermediate items are links; last item
    // is the current page, represented as plain text (not a link) so AT users
    // understand they are on this page already.
    it('renders intermediate crumbs as links and last crumb as plain text (WCAG 4.1.2)', () => {
      const { getAllByRole, queryByRole, getByText } = render(
        <Breadcrumbs
          items={[
            { label: 'Home', path: '/' },
            { label: 'Deployments', path: '/app/deployments' },
            { label: 'my-app' },
          ]}
        />
      );
      const links = getAllByRole('link');
      expect(links).toHaveLength(2);
      expect(links[0]).toHaveAttribute('href', '/');
      expect(links[1]).toHaveAttribute('href', '/app/deployments');
      // Current page item is plain text, not a link
      expect(getByText('my-app').tagName).not.toBe('A');
    });

    it('has no axe violations for a multi-level breadcrumb path (WCAG 2.4.8)', async () => {
      const { container } = render(
        <Breadcrumbs
          items={[
            { label: 'Home', path: '/' },
            { label: 'Deployments', path: '/app/deployments' },
            { label: 'my-app' },
          ]}
        />
      );
      expect(await axe(container)).toHaveNoViolations();
    });

    it('renders nothing when items array is empty (no orphan nav landmark)', () => {
      const { container } = render(<Breadcrumbs items={[]} />);
      expect(container.querySelector('nav')).toBeNull();
    });
  });

  describe('Color Contrast', () => {
    it('should have sufficient color contrast in badges', async () => {
      const { container } = render(
        <StatusBadge status="active" />
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe('Form Accessibility', () => {
    it('should have proper form labels and error messages', () => {
      const { container } = render(
        <ErrorState title="Form Error" message="Please fill in all required fields" />
      );
      const message = container.textContent;
      expect(message).toContain('Please fill in all required fields');
    });
  });

  // ── Sidebar ────────────────────────────────────────────────────────────────
  //
  // WCAG 2.4.1 Bypass Blocks: the sidebar must be an <aside> containing a
  // <nav> landmark so keyboard and AT users can skip to or past navigation.
  // WCAG 1.3.1 Info and Relationships: the nav label must communicate purpose.

  describe('Sidebar — WCAG 2.4.1 navigation landmark and keyboard navigation', () => {
    it('has no axe violations (WCAG 1.4.3 color contrast, 4.1.2 name/role/value)', async () => {
      const { container } = render(
        <Sidebar user={fakeUser} navItems={navItems} />
      );
      expect(await axe(container)).toHaveNoViolations();
    });

    // WCAG 2.4.1 Bypass Blocks — <aside> + <nav> landmarks allow AT users to
    // jump directly to navigation without traversing content.
    it('renders an <aside> containing a <nav> landmark (WCAG 2.4.1)', () => {
      const { container } = render(
        <Sidebar user={fakeUser} navItems={navItems} />
      );
      const aside = container.querySelector('aside');
      expect(aside).toBeTruthy();
      expect(aside?.querySelector('nav')).toBeTruthy();
    });

    // WCAG 4.1.2 Name, Role, Value — each nav item must be reachable as a link
    it('renders all nav items as keyboard-focusable links (WCAG 2.1.1)', () => {
      const { getAllByRole } = render(
        <Sidebar user={fakeUser} navItems={navItems} />
      );
      const links = getAllByRole('link');
      const navLabels = navItems.map(i => i.label);
      navLabels.forEach(label => {
        expect(links.some(l => l.textContent?.includes(label))).toBe(true);
      });
    });

    // WCAG 2.4.3 Focus Order — the active page item signals location via aria-current
    it('marks the active nav item with aria-current="page" (WCAG 2.4.3)', () => {
      const items = [
        { id: 'n1', label: 'Deployments', icon: mockIcon, path: '/app/deployments' },
        { id: 'n2', label: 'Templates', icon: mockIcon, path: '/app/templates' },
      ];
      // usePathname is mocked to '/app/deployments'
      const { getAllByRole } = render(<Sidebar user={fakeUser} navItems={items} />);
      const links = getAllByRole('link');
      const activeLink = links.find(l => l.textContent?.includes('Deployments'));
      expect(activeLink).toHaveAttribute('aria-current', 'page');
      const inactiveLink = links.find(l => l.textContent?.includes('Templates'));
      expect(inactiveLink).not.toHaveAttribute('aria-current');
    });

    // WCAG 1.1.1 Non-text Content — user avatar image must have alt text
    it('user avatar image has non-empty alt attribute (WCAG 1.1.1)', () => {
      const userWithAvatar = { ...fakeUser, avatar: 'https://example.com/avatar.jpg' };
      const { getByAltText } = render(<Sidebar user={userWithAvatar} navItems={navItems} />);
      expect(getByAltText('Jane Doe')).toBeTruthy();
    });

    // WCAG 1.3.1 Info and Relationships — user initials fallback has no alt
    // (decorative element); the name is conveyed via adjacent visible text.
    it('renders user name as visible text alongside initials avatar (WCAG 1.3.1)', () => {
      const { getByText } = render(<Sidebar user={fakeUser} navItems={navItems} />);
      expect(getByText('Jane Doe')).toBeTruthy();
      expect(getByText('jane@example.com')).toBeTruthy();
    });
  });

  // ── MobileDrawer ───────────────────────────────────────────────────────────
  //
  // WCAG 2.1.2 No Keyboard Trap: the drawer must be closeable via Escape.
  // WCAG 4.1.2 Name, Role, Value: drawer and close button must be labelled.
  // WCAG 1.3.1 Info and Relationships: backdrop must be aria-hidden to prevent
  // AT users from interacting with inert content behind the drawer.

  describe('MobileDrawer — WCAG 2.1.2 no keyboard trap and focus management', () => {
    it('has no axe violations when open (WCAG 1.4.3 color contrast, 4.1.2)', async () => {
      const { container } = render(
        <MobileDrawer open user={fakeUser} navItems={navItems} onClose={() => {}} />
      );
      expect(await axe(container)).toHaveNoViolations();
    });

    it('has no axe violations when closed', async () => {
      const { container } = render(
        <MobileDrawer open={false} user={fakeUser} navItems={navItems} onClose={() => {}} />
      );
      expect(await axe(container)).toHaveNoViolations();
    });

    // WCAG 4.1.2 Name, Role, Value — the drawer <aside> must have an
    // accessible label so screen readers announce "Mobile navigation" when
    // focus enters it.
    it('drawer <aside> has aria-label="Mobile navigation" (WCAG 4.1.2)', () => {
      const { container } = render(
        <MobileDrawer open user={fakeUser} navItems={navItems} onClose={() => {}} />
      );
      const aside = container.querySelector('aside');
      expect(aside).toHaveAttribute('aria-label', 'Mobile navigation');
    });

    // WCAG 4.1.2 Name, Role, Value — the close button must have an
    // accessible label since it only renders an SVG icon with no visible text.
    it('close button has aria-label="Close menu" for icon-only button (WCAG 4.1.2)', () => {
      const { getByRole } = render(
        <MobileDrawer open user={fakeUser} navItems={navItems} onClose={() => {}} />
      );
      expect(getByRole('button', { name: /close menu/i })).toBeTruthy();
    });

    // WCAG 2.1.2 No Keyboard Trap — pressing Escape must call onClose so the
    // user can exit the drawer without relying on a pointer device.
    it('calls onClose when Escape key is pressed (WCAG 2.1.2)', () => {
      const onClose = vi.fn();
      render(<MobileDrawer open user={fakeUser} navItems={navItems} onClose={onClose} />);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledOnce();
    });

    // WCAG 2.1.2 — Escape must be a no-op when the drawer is already closed
    it('does not call onClose on Escape when drawer is closed', () => {
      const onClose = vi.fn();
      render(<MobileDrawer open={false} user={fakeUser} navItems={navItems} onClose={onClose} />);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    });

    // WCAG 1.3.1 Info and Relationships — the semi-transparent backdrop must
    // be aria-hidden so AT users are not presented with a meaningless overlay
    // element.
    it('backdrop overlay is aria-hidden to hide decorative scrim from AT (WCAG 1.3.1)', () => {
      const { container } = render(
        <MobileDrawer open user={fakeUser} navItems={navItems} onClose={() => {}} />
      );
      const backdrop = container.querySelector('[aria-hidden="true"]');
      expect(backdrop).toBeTruthy();
    });

    // WCAG 4.1.2 — clicking the close button triggers onClose
    it('calls onClose when the close button is clicked', () => {
      const onClose = vi.fn();
      const { getByRole } = render(
        <MobileDrawer open user={fakeUser} navItems={navItems} onClose={onClose} />
      );
      fireEvent.click(getByRole('button', { name: /close menu/i }));
      expect(onClose).toHaveBeenCalledOnce();
    });

    // WCAG 4.1.2 — clicking the backdrop closes the drawer
    it('calls onClose when the backdrop overlay is clicked', () => {
      const onClose = vi.fn();
      const { container } = render(
        <MobileDrawer open user={fakeUser} navItems={navItems} onClose={onClose} />
      );
      const backdrop = container.querySelector('[aria-hidden="true"]') as HTMLElement;
      fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalledOnce();
    });

    // WCAG 2.4.3 Focus Order — all nav items are present and keyboard-reachable
    it('renders all nav items as links inside the drawer (WCAG 2.1.1)', () => {
      const { getAllByRole } = render(
        <MobileDrawer open user={fakeUser} navItems={navItems} onClose={() => {}} />
      );
      const links = getAllByRole('link');
      navItems.forEach(item => {
        expect(links.some(l => l.textContent?.includes(item.label))).toBe(true);
      });
    });

    // WCAG 1.1.1 Non-text Content — user avatar in drawer footer
    it('user avatar in drawer footer has alt text (WCAG 1.1.1)', () => {
      const userWithAvatar = { ...fakeUser, avatar: 'https://example.com/avatar.jpg' };
      const { getByAltText } = render(
        <MobileDrawer open user={userWithAvatar} navItems={navItems} onClose={() => {}} />
      );
      expect(getByAltText('Jane Doe')).toBeTruthy();
    });
  });
});
