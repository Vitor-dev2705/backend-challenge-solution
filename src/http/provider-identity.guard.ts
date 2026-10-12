import { CanActivate, Injectable } from '@nestjs/common';

@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
