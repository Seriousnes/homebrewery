// Port of legacy client/homebrew/navbar/vault.navitem.jsx.
import { paths } from '@/app/paths';
import { Icon } from '@/ui';
import { NavLinkItem } from './NavItem';

export function VaultNavItem() {
  return (
    <NavLinkItem to={paths.vault} tone="purple" icon={<Icon name="vault" />} collapsible data-testid="nav-vault">
      Vault
    </NavLinkItem>
  );
}
